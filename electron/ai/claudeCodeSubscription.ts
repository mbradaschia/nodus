import { app } from 'electron';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ClaudeCodeSubscriptionStatus,
  ModelInfo,
  ReasoningEffort,
} from '@shared/types';
import type { VisionImagePart } from '@shared/imageAnalysis';
import { ProviderRuntimeError } from './providerErrors';

/**
 * Claude Pro/Max as a Nodus provider, driven through the official Claude Agent SDK.
 *
 * The SDK is a harness around the Claude Code CLI, so this module spawns that CLI the
 * way `codexSubscription` spawns the Codex app-server — but it does not manage its own
 * login. It reads whatever session the user's own `claude` CLI already holds, which is
 * why there is no connect/disconnect here: Nodus observes the session, the terminal
 * owns it. What this module does enforce is that the session is the *subscription* —
 * see {@link sanitizedEnv}, which stops an exported `ANTHROPIC_API_KEY` from silently
 * diverting plan usage onto pay-per-use API billing.
 */

interface ClaudeCodeCompletionOptions {
  model: string;
  system: string;
  user: string;
  reasoning: ReasoningEffort | null;
  timeoutMs?: number;
  images?: VisionImagePart[];
  onDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

/** Shape of `claude auth status --json`. Fields beyond `loggedIn` are absent when signed out. */
interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

const STATUS_UNAVAILABLE: ClaudeCodeSubscriptionStatus = {
  available: false,
  connected: false,
  email: null,
  planType: null,
  organization: null,
  error: null,
};

const statusListeners = new Set<(status: ClaudeCodeSubscriptionStatus) => void>();
let modelCache: ModelInfo[] | null = null;
let modelCacheAt = 0;
/** The catalogue tracks the plan, so a tier change has to become visible without a restart. */
const MODEL_CACHE_TTL_MS = 10 * 60_000;

export function onClaudeCodeSubscriptionStatusChanged(
  listener: (status: ClaudeCodeSubscriptionStatus) => void
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function emitStatus(status: ClaudeCodeSubscriptionStatus): void {
  for (const listener of statusListeners) listener(status);
}

/**
 * Scratch directory used as the runtime's working directory.
 *
 * It is deliberately *not* a credential store: this provider reads the same Claude
 * session the user's own `claude` CLI uses (see {@link sanitizedEnv}). A stable
 * Nodus-owned cwd only keeps the runtime from writing per-project session state into
 * whatever directory the app happened to be launched from.
 */
function claudeCodeWorkdir(): string {
  const dir = path.join(app.getPath('userData'), 'claude-code-runtime');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows and restrictive filesystems */ }
  return dir;
}

function unpackedAsarPath(file: string): string {
  const marker = `${path.sep}app.asar${path.sep}`;
  return file.includes(marker) ? file.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : file;
}

/**
 * The Agent SDK ships the CLI as per-platform optional dependencies and can resolve
 * them itself, but its resolver has no notion of asar: inside a packaged Nodus it
 * would hand back a path that cannot be executed. Resolving here — and rewriting the
 * archive segment the way the Codex and Copilot runtimes do — is what makes the
 * bundled binary launchable from a signed build.
 */
export function resolveClaudeCodeBinaryPath(): string {
  // musl first for Linux: on Alpine-style hosts the glibc build resolves but cannot run.
  const candidates = (() => {
    const suffix = `${process.platform}-${process.arch}`;
    if (process.platform === 'linux') return [`${suffix}-musl`, suffix];
    if (process.platform === 'darwin' || process.platform === 'win32') return [suffix];
    return null;
  })();
  if (!candidates) throw new Error(`Claude Code no es compatible con ${process.platform}/${process.arch}.`);

  // The Electron bundle recreates __filename in its banner; using it also keeps the
  // repository's CommonJS-based TS test harness compatible with this module.
  const require = createRequire(__filename);
  const executableName = process.platform === 'win32' ? 'claude.exe' : 'claude';

  for (const candidate of candidates) {
    const packageName = `@anthropic-ai/claude-agent-sdk-${candidate}`;
    let executable: string | null = null;
    try {
      executable = path.join(path.dirname(require.resolve(`${packageName}/package.json`)), executableName);
    } catch {
      // electron-builder may keep optional dependencies nested under their parent
      // package instead of hoisting them. Fall back to the SDK's own tree — anchored
      // on its entry point, because its `exports` map does not expose package.json.
      try {
        const loader = require.resolve('@anthropic-ai/claude-agent-sdk');
        executable = path.join(path.dirname(loader), 'node_modules', ...packageName.split('/'), executableName);
      } catch {
        continue;
      }
    }
    executable = unpackedAsarPath(executable);
    if (fs.existsSync(executable)) return executable;
  }
  throw new Error('No se encontró el runtime oficial de Claude Code incluido con Nodus.');
}

/**
 * Environment for every spawn of the CLI.
 *
 * Stripping credential-shaped variables is load-bearing rather than defensive: the CLI
 * prefers `ANTHROPIC_API_KEY` over the stored OAuth session, so a key left in the
 * user's shell would bill this provider to their API account while the UI still showed
 * a connected subscription. The 3P backend switches are removed for the same reason —
 * they would silently route the request to Bedrock or Vertex.
 */
function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // `SESSION` is deliberately absent: it matched desktop-integration handles the CLI
    // needs to open a browser during login. Real credentials still match TOKEN/SECRET.
    if (/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)/i.test(name)) continue;
    if (/^(?:CLAUDE_CODE_USE_|ANTHROPIC_(?:BASE_URL|AUTH|MODEL|SMALL_FAST_MODEL))/i.test(name)) continue;
    env[name] = value;
  }
  delete env.NODE_OPTIONS;
  // CLAUDE_CONFIG_DIR is deliberately left alone: passing the user's own value through
  // (or none at all, for the CLI's default) is what makes this provider reuse the
  // session they already signed into from their terminal.

  // This one is a latency fix, not a preference. The CLI performs its startup
  // housekeeping — update check, telemetry, error reporting — before serving the turn,
  // and Nodus pays that on *every* completion because each one is a fresh process. It
  // measured as ~5s of the ~6.8s median round trip on this machine; setting it takes a
  // Sonnet completion from ~6.8s to ~1.6s and collapses the spread (5–10s → 1.5–1.7s).
  // Suppressing the auto-updater is independently correct here: Nodus ships a pinned
  // runtime, so a CLI that upgraded itself underneath the app would be a bug.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

/** Run a short-lived `claude <args>` and return stdout. Used for the auth subcommands. */
function runCli(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(resolveClaudeCodeBinaryPath(), args, {
        env: sanitizedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new ProviderRuntimeError('El runtime de Claude Code no respondió a tiempo.', 'timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

async function readStatus(): Promise<ClaudeCodeSubscriptionStatus> {
  try {
    const { stdout } = await runCli(['auth', 'status', '--json']);
    const parsed = JSON.parse(stdout) as ClaudeAuthStatus;

    // A Console (API-billing) login or a 3P backend is not the subscription the user
    // selected this provider for, so it is reported as "not connected" with a reason
    // rather than quietly spending API credit.
    if (parsed.loggedIn && (parsed.apiProvider ?? 'firstParty') !== 'firstParty') {
      return {
        available: true, connected: false,
        email: null, planType: null, organization: null,
        error: 'Esta sesión de Claude Code usa un proveedor externo (Bedrock, Vertex o Foundry). Nodus solo admite la suscripción de Claude.',
      };
    }
    if (parsed.loggedIn && parsed.authMethod === 'console') {
      return {
        available: true, connected: false,
        email: parsed.email ?? null, planType: null, organization: parsed.orgName ?? null,
        error: 'Esta sesión se autenticó con la consola de Anthropic (facturación por uso). Vuelve a conectar con tu suscripción de Claude.',
      };
    }

    return {
      available: true,
      connected: parsed.loggedIn === true,
      email: parsed.email ?? null,
      planType: parsed.subscriptionType ?? null,
      organization: parsed.orgName ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ...STATUS_UNAVAILABLE,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// A connected account stays connected between calls, so re-reading it before every
// generation would spawn an extra process per completion — which a scan pipeline pays
// hundreds of times. Confirm at most once per window instead. Only a positive result is
// cached, so a session started in the terminal is picked up on the very next call.
let connectedAt = 0;
let connectedCached = false;
const CONNECTED_TTL_MS = 60_000;

function invalidateConnectedCache(): void {
  connectedAt = 0;
  connectedCached = false;
}

async function ensureConnectedForCompletion(): Promise<void> {
  if (connectedCached && Date.now() - connectedAt < CONNECTED_TTL_MS) return;
  const status = await readStatus();
  connectedCached = status.connected;
  connectedAt = Date.now();
  if (!status.connected) {
    throw new ProviderRuntimeError(
      status.error ?? 'No hay una sesión de Claude iniciada. Ejecuta «claude auth login» en tu terminal.',
      'auth'
    );
  }
}

async function refreshAndEmitStatus(): Promise<ClaudeCodeSubscriptionStatus> {
  const status = await readStatus();
  emitStatus(status);
  return status;
}

export async function getClaudeCodeSubscriptionStatus(): Promise<ClaudeCodeSubscriptionStatus> {
  // An explicit status check is also the user's way of saying "I changed something in
  // the terminal", so it drops the completion-side cache rather than letting a stale
  // positive linger for the rest of its window.
  invalidateConnectedCache();
  return refreshAndEmitStatus();
}

// ── Completions ──────────────────────────────────────────────────────────────

/**
 * Nodus asks this provider for one answer to one prompt. Everything that makes the
 * runtime behave like a coding agent is therefore switched off: no tools, no
 * filesystem settings (`CLAUDE.md`, user/project config), and a single turn. Without
 * `settingSources: []` the answer would silently inherit whatever the user happens to
 * have in their Claude Code configuration.
 */
function baseOptions(model: string, system: string, reasoning: ReasoningEffort | null) {
  const effort = reasoning === null || reasoning === 'off' ? undefined : reasoning;
  return {
    model,
    systemPrompt: system,
    tools: [] as string[],
    settingSources: [] as [],
    maxTurns: 1,
    permissionMode: 'dontAsk' as const,
    cwd: claudeCodeWorkdir(),
    env: sanitizedEnv(),
    pathToClaudeCodeExecutable: resolveClaudeCodeBinaryPath(),
    // 'off' means "answer without deliberating"; the other levels map 1:1 onto the
    // SDK's effort ladder, which is what this runtime exposes instead of temperature.
    ...(effort ? { effort } : { thinking: { type: 'disabled' as const } }),
  };
}

function promptFor(user: string, images: VisionImagePart[] | undefined) {
  if (!images?.length) return user;
  // Vision has to go through the streaming-input form: only a full message param can
  // carry image blocks alongside the text.
  const content = [
    { type: 'text' as const, text: user },
    ...images.map((image) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: image.mediaType as 'image/png', data: image.base64 },
    })),
  ];
  return (async function* () {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content },
      parent_tool_use_id: null,
      session_id: '',
    };
  })();
}

export async function completeWithClaudeCodeSubscription(
  opts: ClaudeCodeCompletionOptions
): Promise<string> {
  await ensureConnectedForCompletion();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  const timer = opts.timeoutMs ? setTimeout(abort, opts.timeoutMs) : null;

  let streamed = '';
  let stderrTail = '';
  try {
    const response = query({
      prompt: promptFor(opts.user, opts.images),
      options: {
        ...baseOptions(opts.model, opts.system, opts.reasoning),
        abortController: controller,
        includePartialMessages: Boolean(opts.onDelta || opts.onReasoningDelta),
        stderr: (data: string) => { stderrTail = `${stderrTail}${data}`.slice(-2_000); },
      },
    });

    for await (const message of response) {
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type !== 'content_block_delta') continue;
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          streamed += delta.text;
          opts.onDelta?.(delta.text);
        } else if (delta.type === 'thinking_delta') {
          opts.onReasoningDelta?.(delta.thinking);
        }
        continue;
      }
      if (message.type !== 'result') continue;
      if (message.subtype === 'success') return message.result;
      // A caller-driven stop surfaces here as an execution error; the partial answer
      // it already streamed is worth more than a thrown turn.
      if (controller.signal.aborted) return streamed;
      throw new ProviderRuntimeError(
        describeResultError(message.subtype, stderrTail),
        message.subtype === 'error_max_turns' ? 'invalid' : 'unavailable'
      );
    }
    if (controller.signal.aborted) return streamed;
    // The generator can end without a result when the CLI dies mid-turn.
    throw new ProviderRuntimeError(
      stderrTail.trim() || 'El runtime de Claude Code terminó sin devolver una respuesta.',
      'unavailable'
    );
  } catch (error) {
    if (controller.signal.aborted && !opts.timeoutMs) return streamed;
    throw normalizeError(error, stderrTail);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }
}

function describeResultError(subtype: string, stderrTail: string): string {
  const detail = stderrTail.trim();
  if (subtype === 'error_max_turns') return 'Claude Code agotó el turno disponible sin completar la respuesta.';
  return detail || 'Claude Code no pudo completar la respuesta.';
}

/** Map SDK/CLI failures onto the classification the retry ladder understands. */
function normalizeError(error: unknown, stderrTail: string): Error {
  if (error instanceof ProviderRuntimeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const haystack = `${message} ${stderrTail}`.toLowerCase();
  if (/not found at the configured path|failed to launch/.test(haystack)) {
    return new ProviderRuntimeError('El ejecutable de Claude Code incluido con Nodus no pudo iniciarse.', 'unavailable');
  }
  if (/unauthor|authentication|not logged in|invalid api key|oauth/.test(haystack)) {
    return new ProviderRuntimeError('La suscripción de Claude rechazó la sesión. Vuelve a conectarla en Proveedores y modelos.', 'auth');
  }
  if (/rate limit|quota|usage limit|overloaded/.test(haystack)) {
    return new ProviderRuntimeError('Has alcanzado el límite de uso de tu plan de Claude.', 'rateLimit');
  }
  if (/timed? ?out|abort/.test(haystack)) {
    return new ProviderRuntimeError('Claude Code no respondió a tiempo.', 'timeout');
  }
  return new ProviderRuntimeError(message || 'Claude Code no pudo completar la respuesta.', 'unavailable');
}

// ── Model catalogue ──────────────────────────────────────────────────────────

/**
 * The catalogue comes from the runtime rather than a hardcoded list so a plan change
 * or a newly released model shows up without a Nodus release. `supportedModels` is a
 * control request, so it needs a live query — the prompt is never sampled because the
 * generator is closed as soon as the answer arrives.
 */
export async function listClaudeCodeSubscriptionModels(force = false): Promise<ModelInfo[]> {
  if (!force && modelCache && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) return modelCache;
  await ensureConnectedForCompletion();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const controller = new AbortController();
  const response = query({
    prompt: '',
    options: { ...baseOptions('sonnet', '', null), abortController: controller },
  });
  try {
    const models = await response.supportedModels();
    modelCache = models.map((model) => ({
      id: model.value,
      name: model.displayName || model.value,
      reasoning: model.supportsEffort === true,
    }));
    modelCacheAt = Date.now();
    return modelCache;
  } catch (error) {
    throw normalizeError(error, '');
  } finally {
    response.close();
  }
}
