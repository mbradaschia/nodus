# ADR-006: proveedor de suscripción de Claude

- Estado: aceptado
- Fecha: 2026-08-16

## Contexto

Nodus ya admite dos proveedores facturados contra una suscripción personal en
lugar de crédito de API: ChatGPT a través del App Server de Codex y GitHub
Copilot a través de su SDK oficial. Falta el equivalente para quienes tienen un
plan Claude (Pro o Max), cuyo consumo se factura contra la cuota del plan.

El acceso a ese plan solo existe a través de la sesión que abre la CLI oficial
de Claude Code. Eso plantea la decisión central: si Nodus gestiona su propia
sesión —como hace con Codex, que tiene su propio `CODEX_HOME`— o si reutiliza la
que el usuario ya tiene en su terminal. La primera opción duplica el inicio de
sesión; la segunda comparte credenciales entre dos programas.

Existe además un riesgo específico de facturación: la CLI prefiere
`ANTHROPIC_API_KEY` sobre la sesión OAuth almacenada. Una variable exportada en
el entorno del usuario bastaría para que el consumo fuera a su cuenta de API
mientras la interfaz sigue mostrando una suscripción conectada.

## Decisión

1. La integración usa el Claude Agent SDK oficial. El SDK distribuye la CLI como
   dependencias opcionales por plataforma, de modo que el runtime viaja con
   Nodus igual que los de Codex y Copilot. Sus binarios se desempaquetan del
   asar porque un ejecutable dentro del archivo no puede lanzarse.
2. La ruta del binario se resuelve en `claudeCodeSubscription.ts` y no mediante
   el resolutor del SDK, que no conoce el asar y devolvería una ruta inejecutable
   en una compilación empaquetada. La resolución contempla el caso en que
   electron-builder anida la dependencia opcional bajo su paquete padre en lugar
   de elevarla: en la compilación de macOS es exactamente lo que ocurre, y sin
   ese respaldo el proveedor falla solo en la app empaquetada.
3. Nodus **no gestiona el inicio de sesión**: lee la sesión que ya tiene la CLI
   del usuario. La terminal es la dueña de la sesión y Nodus solo la observa, así
   que la superficie IPC es de solo lectura —estado y suscripción a cambios— y no
   hay conectar ni desconectar. Ninguna credencial cruza IPC.
4. El entorno de cada proceso se sanea: se eliminan las variables con forma de
   credencial y los conmutadores de proveedores externos (Bedrock, Vertex). Esto
   es funcional, no defensivo: evita que una `ANTHROPIC_API_KEY` del entorno
   desvíe en silencio el consumo del plan a facturación por uso.
5. Cada petición es un turno aislado: sin herramientas, sin ajustes de disco y
   con un solo turno. Sin `settingSources: []` la respuesta heredaría el
   `CLAUDE.md` y la configuración personal del usuario.
6. Se fija `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. La CLI ejecuta su
   mantenimiento de arranque —comprobación de actualización, telemetría, informe
   de errores— antes de atender el turno, y Nodus lo paga en cada compleción
   porque cada una es un proceso nuevo: medido, eran unos 5 s de una mediana de
   6,8 s. Silenciar el actualizador es además correcto por sí mismo, porque el
   runtime va anclado a una versión y no debe actualizarse por su cuenta.
7. La pregunta «¿este proveedor necesita clave?» se responde una sola vez, en
   `requiresApiKey()`. Los runtimes de suscripción, los servidores locales y el
   runtime incluido llegan al modelo sin clave; para ellos la ausencia de clave
   es su estado normal y no configuración incompleta.

## Consecuencias

No hay pantalla de inicio de sesión: el usuario ejecuta `claude auth login` en su
terminal y Nodus refleja esa sesión. Cerrar sesión en la terminal desconecta
también a Nodus, que es el precio de no duplicar credenciales ni escribir en el
almacén de otro programa.

El proveedor no admite `temperature`, `max_tokens` ni modo JSON, como los otros
dos de suscripción; `supportsSamplingControls` ya evitaba que la escalera de
reintentos de `completeJson` gastara turnos idénticos descubriéndolo. El catálogo
de modelos lo publica el runtime, de modo que un cambio de plan aparece sin
necesidad de una versión nueva.

El paquete crece en unos 300 MB por el binario de la CLI. La integración obliga a
subir `@anthropic-ai/sdk` y `zod` a v4 —con un override por el par opcional de
`openai@4`—, cambios verificados como seguros: los dos usos de la SDK de
Anthropic emplean solo la superficie estable de `messages`, y el único consumidor
de zod usa constructores que v4 no altera.

Con el tráfico no esencial desactivado, una compleción de Sonnet queda en torno a
1,6 s, con el gasto restante dominado por el arranque del proceso. Mantener un
proceso vivo entre compleciones —como hace el runtime de Codex— es la siguiente
optimización posible, pero exige reiniciar la conversación entre turnos para no
arrastrar contexto de una tarea a otra.
