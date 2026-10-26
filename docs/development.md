# Desenvolvimento

## Estado do repositório

Etapas 1 e 2: documentação, contrato v1 e agente Spotify em Node.js/TypeScript. `simulator/` e `firmware/` continuam reservados; não há interface gráfica nem integração com o dispositivo.

## Requisitos e comandos atuais

- Node.js 22 ou superior para as ferramentas de lint e teste.
- npm compatível com a versão do Node.js.
- `npm ci` instala o lint e as ferramentas de contrato da raiz.
- `npm ci --prefix agent` instala as dependências do agente e do cofre seguro do sistema.
- npm run lint verifica arquivos Markdown.
- npm test executa testes de contrato com o test runner nativo do Node.js.
- `npm --prefix agent run build` compila o agente TypeScript.
- `npm --prefix agent test` executa testes unitários e de integração com fetch e providers simulados.
- npm run check executa lint, testes de contrato, build TypeScript e testes do agente; make check é um atalho equivalente.

Os testes de agente cobrem PKCE, callback loopback, refresh, normalização, respostas 204/401/429, reconexão, cache e estado local. Não fazem chamadas à Spotify Web API nem validam uma conta real. Também não testam mídia, simulador ou hardware.

## Convenções

- UTF-8, LF e nomes de arquivos em kebab-case para documentos.
- Manter os schemas e exemplos de contracts/v1/ alinhados com docs/protocol.md.
- O agente guarda refresh tokens pelo cofre nativo do sistema, sem fallback para arquivos locais. No Linux, o adaptador exige Secret Service para persistência entre reinicializações.
- A dependência de runtime `@napi-rs/keyring` 1.3.0 é MIT; o upstream publica avisos das bibliotecas embutidas, incluindo `libdbus` (AFL-2.1 ou GPL-2.0-or-later no binário Linux). Conferir os avisos upstream antes de redistribuir binários.
- O agente consulta somente `GET /me/player/currently-playing`, usando o escopo `user-read-currently-playing`.
- `PlaybackPoller.currentSnapshot` e `subscribe()` formam a interface local em processo para futuros consumidores; ela não abre porta de rede e não transporta tokens.
- A URL da capa permanece como metadado interno. Download, conversão e envio da imagem ficam para as etapas posteriores.
- Licenças e atribuições de futuras dependências e assets precisam ser registradas antes de incluí-los.
- A linguagem e a configuração de build do firmware dependem da identificação do hardware.

## Estrutura futura

O agente usa Node.js + TypeScript; firmware em C++/PlatformIO, com alvo ainda não confirmado. O simulador deve preceder qualquer validação de tela no relógio. Os comandos para instalar, autorizar e iniciar o agente estão em [installation.md](installation.md).
