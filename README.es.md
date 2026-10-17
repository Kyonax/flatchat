# FlatChat

> **FlatChat es un nombre en clave.** La plataforma tendrá su propio nombre y logo antes de su lanzamiento.

Una plataforma social de mundos, como VRChat o Second Life, que se juega en una pantalla normal, sin realidad virtual. Cualquiera puede alojar un mundo desde su propio PC; sus amigos y seguidores entran, hablan con voz por proximidad y aparecen con los avatares que crearon. Los mundos crecen con plugins.

Es gratis: sin pagos, sin cripto, sin anuncios ni rastreo, sin anti-trampas a nivel de kernel.

Creado por [Kyonax](https://github.com/Kyonax). · [Read in English](README.md)

## Estado

**Etapa 0 del MVP: bases y pruebas de concepto. Todavía no hay nada jugable.**

La etapa 0 monta este repositorio, las herramientas, la integración continua y el arnés de pruebas, y mide las cuatro mayores incógnitas antes de que la primera etapa jugable dependa de ellas:

- **200 jugadores en un mundo:** bots sobre el protocolo real, contra un servidor de mundo en un PC de casa.
- **La voz:** eco, ruido, retardo y desvanecimiento con la distancia, en portátiles comunes.
- **Multitudes en un portátil modesto:** gráficos Intel Iris Xe o AMD Radeon 680M, 720p, 30 cuadros por segundo.
- **Llegar a un PC de casa:** a través de routers domésticos y del NAT de los operadores (CGNAT), con un servidor de retransmisión cuando nada más funciona.

Después, el MVP etapa por etapa: el núcleo en greybox (cuentas, el mundo del creador, entrar, moverse, chat de texto y voz por proximidad), mundos y viajes, plugins y moderación, avatares, efectos y una prueba cerrada con la comunidad.

## Las partes

| Carpeta | Qué es |
|---|---|
| `apps/client` | La app de escritorio para Windows y Linux: inicio de sesión, ajustes, el explorador de mundos, el mundo en 3D, la voz y un modo sin conexión |
| `apps/world-server` | El servidor de un mundo, que su anfitrión ejecuta sin interfaz |
| `apps/core` | El servicio central: cuentas, el registro de servidores, las subidas, el almacén de recursos, la galería y la moderación |
| `packages/protocol` | Los mensajes de red que hablan todos los programas |
| `packages/sim` | Las reglas de movimiento, compartidas por la predicción del cliente y las comprobaciones del servidor |
| `packages/content` | Los manifiestos de mundos y avatares, los rangos de rendimiento y el validador del formato de mundo |
| `packages/plugin-sdk` | Lo que puede llamar un plugin de mundo |
| `tools/converter` | Convierte los modelos subidos al formato de la plataforma |
| `tools/host-tool` | El servidor de mundo, el conversor y un asesor de capacidad, en una sola descarga para anfitriones |
| `tools/bots` | Clientes sin interfaz que hablan el protocolo real, para pruebas de carga |
| `tools/blender` | El script puente con Blender |
| `tools/repo` | Comprobaciones de este repositorio |
| `tools/harness` | Todas las comprobaciones sin pantalla en un solo comando, el linter de trampas y el sustituto de portátil débil |
| `kits` | Los tres kits de cuerpos y la biblioteca base |
| `docs` | El protocolo, el formato de mundo, la API de plugins, los informes de las pruebas y las páginas de ayuda |

**Las herramientas son provisionales** hasta una comparación directa entre las dos finalistas en la etapa 0: TypeScript en todo, three.js dentro de Electron para el cliente, Node.js para los servidores. Si gana Godot con C#, cambian el cliente y el servidor de mundo, y todo lo demás se queda.

## Licencias

Cada carpeta tiene su propia licencia, elegida según su papel ([LICENSING.md](LICENSING.md)):

| Carpeta | Licencia |
|---|---|
| `apps/core` | AGPL-3.0-or-later |
| `apps/client`, `apps/world-server`, `tools/converter`, `tools/host-tool`, `tools/bots`, `tools/harness` | MPL-2.0 |
| `packages/*` | Apache-2.0 |
| `tools/blender` | GPL-3.0-or-later |
| `kits`, `docs` | CC BY 4.0 |
| Todo lo demás | MPL-2.0 (la [LICENSE](LICENSE) de la raíz) |

El material de terceros conserva su propia licencia y figura en [CREDITS.md](CREDITS.md).

## Para trabajar en él

Necesitas [mise](https://mise.jdx.dev) (o asdf), que instala el Node.js 24 LTS fijado en `.tool-versions`, o Node.js 24 instalado a tu manera.

```sh
mise install           # Node.js 24 LTS, como lo fija .tool-versions
npm install            # todos los espacios de trabajo
npm run client         # el cliente, con recarga en vivo (la primera vez descarga Electron, unos 110 MB)
npm run server         # un servidor de mundo en el puerto UDP 7777; Ctrl+C lo detiene
npm test               # pruebas unitarias y de procesos
npm run lint           # ESLint con las reglas de TypeScript y Vue
npm run typecheck      # TypeScript en todos los espacios de trabajo
npm run check:layout   # la estructura de carpetas, los archivos de licencia y las cabeceras SPDX
npm run client:smoke   # compila el cliente, dibuja 3 s, imprime su backend gráfico y sus cuadros por segundo, y sale
npm run harness        # todo lo anterior que no necesita pantalla, más el linter de trampas, la revisión de la skill de agentes, un servidor de mundo sin interfaz y 12 bots en cada transporte
npm run lint:traps     # solo el linter de trampas: los errores de seguridad y de configuración que este proyecto ya encontró
npm run golden -w @flatchat/protocol   # comprueba que los paquetes de referencia del protocolo están al día
npm run bots -- smoke  # un servidor de mundo y 12 bots en cada transporte (UDP puro, WebRTC) durante 4 s
```

El servidor de mundo acepta `--port` (0 elige uno libre), `--transport udp|rtc|both`, `--tick-hz` y `--ticks` (se detiene tras ese número de ticks), por ejemplo `npm run server -- --port 0 --ticks 100`; [apps/world-server](apps/world-server/README.md) enumera el resto. Para probarlo con carga, `npm run bots -- run --transport rtc --bots 200 --minutes 30` arranca un servidor y 200 bots en una red aislada y escribe un informe ([tools/bots](tools/bots/README.md)).

El núcleo necesita los programas de PostgreSQL (no un servicio en marcha): `npm run core:db -- start` crea una base de datos privada en tu carpeta personal e imprime su cadena de conexión; [apps/core](apps/core/README.md) explica el resto (su configuración, la línea de comandos de administración, las invitaciones, la aprobación de un mundo).

Para empaquetar el cliente: `npm run dist:linux -w @flatchat/client` arma una carpeta sin empaquetar para Linux, y `npm run dist:win -w @flatchat/client` arma un zip para Windows desde Linux, sin Wine. Ambos quedan en `apps/client/release/`.

Para medir el cliente en un sustituto de portátil débil (una tarjeta NVIDIA bloqueada a relojes de clase Iris Xe y el cliente limitado a cuatro núcleos), `npm run standin -- plan --target iris-xe` imprime cada comando que correría; `run` los corre, pide sudo solo para las líneas de los relojes y siempre deja la tarjeta como estaba. Lee un perfil escrito para la máquina, descrito en [tools/harness](tools/harness/README.md).

Los agentes de programación con IA empiezan por [AGENTS.md](AGENTS.md).

Cada push y cada pull request corre el arnés en GitHub Actions, y luego compila el cliente para Linux y Windows y le hace una prueba rápida en ambos ([ci.yml](.github/workflows/ci.yml)).

Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un pull request.
