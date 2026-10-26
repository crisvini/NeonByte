# NeonByte

NeonByte é um projeto open-source planejado para um display Wi-Fi JUZIPi SD PRO e um agente desktop que consulta o Spotify. O dispositivo terá duas telas: Spotify Now Playing e GIF fullscreen. A unidade de hardware ainda não foi identificada.

## Estado atual

A **Etapa 1 está concluída**. A Etapa 2 implementa o agente Spotify em Node.js/TypeScript, OAuth PKCE, polling e estado interno compatível com o contrato v1. A validação de OAuth com uma conta real depende de credenciais Spotify configuradas; os testes automatizados usam mocks. Simulador, interface gráfica, integração com dispositivo e firmware continuam fora desta etapa. Nenhum firmware foi compilado ou gravado.

A resolução de 240 × 240 é uma expectativa do planejamento, não uma medição desta unidade. Veja [investigação de hardware](docs/hardware.md) antes de qualquer trabalho que dependa da placa.

## Modos de tela planejados

| Modo | Com reprodução ativa e agente conectado | Sem reprodução ou agente indisponível |
|---|---|---|
| **auto** | Spotify Now Playing | GIF fullscreen |
| **spotify** | Spotify Now Playing | Tela Spotify em espera |
| **gif** | GIF fullscreen | GIF fullscreen |

O dispositivo deve manter localmente o modo escolhido e a animação. O agente consulta e normaliza a reprodução; a integração com o dispositivo ainda não está implementada.

## Estrutura

```text
.
├── agent/                 # Agente Spotify Node.js/TypeScript
├── assets/samples/        # Amostras futuras, sem assets incluídos
├── contracts/v1/          # Schemas e exemplos dos contratos
├── docs/                  # Hardware, protocolo, desenvolvimento e pendências
├── firmware/              # Estrutura reservada; hardware ainda não confirmado
├── simulator/             # Estrutura reservada para a Etapa 3
├── tests/                 # Testes dos contratos v1
├── AGENTS.md
├── PLANNING.md
└── README.md
```

## Validações

Requer Node.js 22 ou superior. No Fedora, uma sessão Secret Service (por exemplo GNOME Keyring ou KWallet) precisa estar disponível para persistir o refresh token. No Windows, o agente usa o Credential Manager.

```sh
npm ci
npm ci --prefix agent
npm run lint
npm test
# ou
npm run check
```

`npm run check` também verifica os tipos e executa os testes do agente. Para autorizar e iniciar o agente, copie `.env.example` para `.env`, preencha `SPOTIFY_CLIENT_ID`, registre o redirect URI exato no Spotify Developer Dashboard e execute:

```sh
npm --prefix agent run build
npm --prefix agent run auth
npm --prefix agent run start
```

O comando `auth` exibe uma URL para abrir no navegador e recebe o retorno em `127.0.0.1`. O refresh token fica no cofre seguro do sistema; tokens não são escritos em `.env` nem nos logs. `SPOTIFY_POLL_INTERVAL_MS` configura o intervalo (15 segundos por padrão). Veja [desenvolvimento](docs/development.md) e [instalação](docs/installation.md) para detalhes.

## Documentação

- [Planejamento e limites das etapas](PLANNING.md)
- [Instruções para agentes de código](AGENTS.md)
- [Hardware e incógnitas](docs/hardware.md)
- [Contrato HTTP v1](docs/protocol.md)
- [Desenvolvimento](docs/development.md)
- [Instalação](docs/installation.md)
- [Recuperação](docs/recovery.md)
