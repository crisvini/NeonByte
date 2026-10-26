# Desenvolvimento

## Estado do repositório

Etapas 1 a 3: documentação, contrato v1, agente Spotify e interface local com simulador 240 × 240. A interface usa o estado do agente e pode funcionar com conta Spotify ou dados de demonstração, sem dispositivo conectado. `firmware/` continua reservado; resolução, cores, orientação e desempenho reais da unidade permanecem PENDENTE.

## Requisitos e comandos atuais

- Node.js 22 ou superior para as ferramentas de lint e teste.
- npm compatível com a versão do Node.js.
- `npm ci` instala o lint e as ferramentas de contrato da raiz.
- `npm ci --prefix agent` instala as dependências do agente, do cofre seguro do sistema e do decodificador GIF.
- npm run lint verifica arquivos Markdown.
- npm test executa testes de contrato com o test runner nativo do Node.js.
- `npm --prefix agent run build` compila o agente TypeScript e copia os arquivos estáticos do painel.
- `npm --prefix agent test` executa testes unitários e de integração com fetch e providers simulados.
- npm run check executa lint, testes de contrato, build TypeScript e testes do agente; make check é um atalho equivalente.

Os testes de agente cobrem PKCE, callback loopback, refresh, normalização, respostas 204/401/429, reconexão, cache, simulador, modos, upload, conversão de mídia e limites/checksums. Não fazem chamadas à Spotify Web API nem validam uma conta real ou hardware.

## Interface local e simulador

Com `.env` configurado (ou sem um Client ID Spotify válido para iniciar a demonstração), execute `npm --prefix agent run build` e `npm --prefix agent run start`. Abra [http://localhost:8787](http://localhost:8787). O servidor se vincula somente a `127.0.0.1`; `NEONBYTE_PORT` precisa corresponder à porta de `SPOTIFY_REDIRECT_URI` para que o callback OAuth volte ao mesmo servidor. O painel permite conectar Spotify com o PKCE existente, escolher `auto`, `spotify` e `gif`, simular play/pausa/troca/offline e enviar um GIF.

O simulador conserva a composição lógica em 240 × 240 e amplia o canvas com CSS responsivo. `auto` seleciona Spotify somente quando o estado recente do agente confirma reprodução. O modo manual Spotify mostra espera sem faixa; o modo GIF e o fallback de `auto` ocupam o quadro todo com a animação. O estado do relógio é sempre “simulação sem dispositivo”; a Etapa 3 não conecta a unidade física.

### Formato intermediário de mídia do simulador

O agente usa `gifuct-js` 2.1.2 (MIT) para ler os quadros do GIF. O formato de prévia é experimental e não constitui um contrato v1 nem um codec confirmado para o hardware:

- `NBIF` (animação): bytes `NBIF`, versão `1` (u8), largura e altura `240` (u16 little-endian), quantidade de quadros (u16 little-endian); em seguida, cada quadro contém atraso em milissegundos (u16 little-endian) e 240 × 240 pixels RGB565 little-endian.
- `NBIC` (capa): bytes `NBIC`, versão `1` (u8), largura e altura `240` (u16 little-endian), seguidos por 240 × 240 pixels RGB565 little-endian.
- SHA-256 em hexadecimal minúsculo cobre o arquivo intermediário completo, incluindo cabeçalho e temporizações.
- GIF: máximo de 8 MiB, 20 quadros, 1.048.576 pixels por dimensão lógica ou descritor de quadro, 4.194.304 pixels somados nos descritores e 30 segundos de duração total. Os descritores são limitados antes da descompressão. Quadro com atraso menor que 20 ms usa 20 ms; atraso zero usa 100 ms. A política de escala é `cover`, com corte central. O descarte GIF de tipo 2 restaura a cor global de fundo, mantendo transparência quando o índice de fundo coincide com o índice transparente.
- Capa: o navegador decodifica a imagem para RGBA, recorta ao centro para 240 × 240 e o agente converte os pixels para RGB565.

GIF e capa convertidos ficam em memória durante a sessão local e são descartados quando o agente encerra. Os limites e o formato existem para a prévia e precisam ser revistos com medições de flash, RAM e velocidade antes de qualquer integração ao firmware. O pacote decodificador está documentado em [gifuct-js](https://github.com/matt-way/gifuct-js).

## Convenções

- UTF-8, LF e nomes de arquivos em kebab-case para documentos.
- Manter os schemas e exemplos de contracts/v1/ alinhados com docs/protocol.md.
- O agente guarda refresh tokens pelo cofre nativo do sistema, sem fallback para arquivos locais. No Linux, o adaptador exige Secret Service para persistência entre reinicializações.
- A dependência de runtime `@napi-rs/keyring` 1.3.0 é MIT; o upstream publica avisos das bibliotecas embutidas, incluindo `libdbus` (AFL-2.1 ou GPL-2.0-or-later no binário Linux). Conferir os avisos upstream antes de redistribuir binários.
- O agente consulta somente `GET /me/player/currently-playing`, usando o escopo `user-read-currently-playing`.
- `PlaybackPoller.currentSnapshot` e `subscribe()` formam a interface local em processo para futuros consumidores; ela não abre porta de rede e não transporta tokens.
- A URL da capa Spotify permanece como metadado interno do agente. O painel baixa a imagem somente do host de mídia permitido e a converte para a prévia; envio ao dispositivo fica para etapas posteriores.
- `gifuct-js` 2.1.2 é MIT; o asset vetorial original de demonstração segue a licença MIT do repositório. Os arquivos de licença do pacote permanecem no `agent/node_modules` após a instalação.
- A linguagem e a configuração de build do firmware dependem da identificação do hardware.

## Próximas etapas

O agente usa Node.js + TypeScript; firmware em C++/PlatformIO, com alvo ainda não confirmado. A integração com o relógio depende da autorização da etapa seguinte e da validação do hardware descrita em [hardware.md](hardware.md). Os comandos para instalar, autorizar e iniciar o agente estão em [installation.md](installation.md).
