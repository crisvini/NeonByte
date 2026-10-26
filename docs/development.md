# Desenvolvimento

## Estado do repositório

Esta base cobre a Etapa 1: documentação, contratos e validações. Os diretórios agent/, simulator/ e firmware/ são apenas estrutura reservada; não há aplicação para iniciar ou compilar.

## Requisitos e comandos atuais

- Node.js 22 ou superior para as ferramentas de lint e teste.
- npm compatível com a versão do Node.js.
- npm ci instala somente ferramentas de desenvolvimento documentadas em package-lock.json.
- npm run lint verifica arquivos Markdown.
- npm test executa testes de contrato com o test runner nativo do Node.js.
- npm run check executa lint e testes; make check é um atalho equivalente.

Os testes validam a estrutura dos schemas e exemplos JSON desta etapa. Não testam comunicação HTTP, Spotify, mídia, simulador nem hardware.

## Convenções

- UTF-8, LF e nomes de arquivos em kebab-case para documentos.
- Manter os schemas e exemplos de contracts/v1/ alinhados com docs/protocol.md.
- Não adicionar dependências de runtime enquanto não houver componente que as utilize.
- Licenças e atribuições de futuras dependências e assets precisam ser registradas antes de incluí-los.
- A linguagem e a configuração de build do firmware dependem da identificação do hardware.

## Estrutura futura

O agente está planejado em Node.js + TypeScript; firmware em C++/PlatformIO, com alvo ainda não confirmado. O simulador deve preceder qualquer validação de tela no relógio. As configurações e comandos próprios de cada componente serão definidos na etapa autorizada correspondente.
