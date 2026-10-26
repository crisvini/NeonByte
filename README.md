# NeonByte

NeonByte é um projeto open-source planejado para um display Wi-Fi JUZIPi SD PRO e um agente desktop que consulta o Spotify. O dispositivo terá duas telas: Spotify Now Playing e GIF fullscreen. A unidade de hardware ainda não foi identificada.

## Estado atual

As **Etapas 1, 2 e 3 estão concluídas**. O agente Spotify em Node.js/TypeScript usa OAuth PKCE, polling e estado compatível com o contrato v1. A interface local inclui simulador responsivo 240 × 240, visualização de Spotify e GIF em loop, modos de tela, upload e dados de demonstração. A validação de OAuth com uma conta real depende de credenciais Spotify configuradas. O relógio físico, firmware e sincronização com dispositivo ainda não estão implementados; nenhum firmware foi compilado ou gravado.

A resolução de 240 × 240 é uma expectativa do planejamento, não uma medição desta unidade. Veja [investigação de hardware](docs/hardware.md) antes de qualquer trabalho que dependa da placa.

## Modos de tela planejados

| Modo | Com reprodução ativa e agente conectado | Sem reprodução ou agente indisponível |
|---|---|---|
| **auto** | Spotify Now Playing | GIF fullscreen |
| **spotify** | Spotify Now Playing | Tela Spotify em espera |
| **gif** | GIF fullscreen | GIF fullscreen |

O simulador aplica os modos à prévia local; o modo escolhido fica guardado no navegador. O agente consulta e normaliza a reprodução. Persistência no dispositivo e integração com o relógio ainda não estão implementadas.

## Estrutura

```text
.
├── agent/                 # Agente Spotify, painel e simulador Node.js/TypeScript
├── assets/samples/        # Amostras futuras, sem assets incluídos
├── contracts/v1/          # Schemas e exemplos dos contratos
├── docs/                  # Hardware, protocolo, desenvolvimento e pendências
├── firmware/              # Estrutura reservada; hardware ainda não confirmado
├── simulator/             # Local reservado; simulador servido pelo agente em agent/src/web
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
npm --prefix agent run start
```

Abra [http://localhost:8787](http://localhost:8787), conecte o Spotify pelo botão e escolha um modo. Sem Client ID válido, o agente inicia com dados mock; os controles permitem simular play, pausa, próxima faixa e indisponibilidade. O comando `auth` continua disponível se preferir autorizar sem abrir a interface. O refresh token fica no cofre seguro do sistema; tokens não são escritos em `.env` nem nos logs. `SPOTIFY_POLL_INTERVAL_MS` configura o intervalo (15 segundos por padrão). Veja [desenvolvimento](docs/development.md) e [instalação](docs/installation.md) para detalhes.

## Documentação

- [Planejamento e limites das etapas](PLANNING.md)
- [Instruções para agentes de código](AGENTS.md)
- [Hardware e incógnitas](docs/hardware.md)
- [Contrato HTTP v1](docs/protocol.md)
- [Desenvolvimento](docs/development.md)
- [Instalação](docs/installation.md)
- [Recuperação](docs/recovery.md)
