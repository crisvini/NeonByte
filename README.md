# NeonByte

NeonByte é um projeto open-source planejado para um display Wi-Fi JUZIPi SD PRO e um agente desktop que consulta o Spotify. O dispositivo terá duas telas: Spotify Now Playing e GIF fullscreen. A unidade de hardware ainda não foi identificada.

## Estado atual

A **Etapa 1 está concluída**; a Etapa 2 aguarda autorização. Há documentação inicial, contratos do protocolo v1 e validações desses contratos. Agente Spotify, simulador e firmware ainda não foram implementados. Nenhum firmware foi compilado ou gravado.

A resolução de 240 × 240 é uma expectativa do planejamento, não uma medição desta unidade. Veja [investigação de hardware](docs/hardware.md) antes de qualquer trabalho que dependa da placa.

## Modos de tela planejados

| Modo | Com reprodução ativa e agente conectado | Sem reprodução ou agente indisponível |
|---|---|---|
| **auto** | Spotify Now Playing | GIF fullscreen |
| **spotify** | Spotify Now Playing | Tela Spotify em espera |
| **gif** | GIF fullscreen | GIF fullscreen |

O dispositivo deve manter localmente o modo escolhido e a animação. Os contratos ainda não são uma implementação executável.

## Estrutura

```text
.
├── agent/                 # Estrutura reservada para a Etapa 2
├── assets/samples/        # Amostras futuras, sem assets incluídos
├── contracts/v1/          # Schemas e exemplos dos contratos
├── docs/                  # Hardware, protocolo, desenvolvimento e pendências
├── firmware/              # Estrutura reservada; hardware ainda não confirmado
├── simulator/             # Estrutura reservada para a Etapa 3
├── tests/                 # Testes iniciais dos contratos
├── AGENTS.md
├── PLANNING.md
└── README.md
```

## Validações

Requer Node.js 22 ou superior para as ferramentas de validação deste repositório.

```sh
npm ci
npm run lint
npm test
# ou
npm run check
```

As verificações atuais cobrem estilo Markdown e coerência básica entre schemas e exemplos JSON. Não compilam nem testam firmware, agente ou simulador.

## Documentação

- [Planejamento e limites das etapas](PLANNING.md)
- [Instruções para agentes de código](AGENTS.md)
- [Hardware e incógnitas](docs/hardware.md)
- [Contrato HTTP v1](docs/protocol.md)
- [Desenvolvimento](docs/development.md)
- [Instalação](docs/installation.md)
- [Recuperação](docs/recovery.md)
