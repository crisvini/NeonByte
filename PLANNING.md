# NeonByte — Plano de implementação

> **Status:** Etapas 1, 2 e 3 implementadas; validação OAuth com conta real pendente de credenciais Spotify. A Etapa 4 aguarda autorização explícita e identificação do hardware · **Licença pretendida:** MIT · **Dispositivo-alvo:** JUZIPi SD PRO (identificação de hardware pendente)
>
> **Regra principal:** implementar as fases sequencialmente; nenhuma gravação de firmware até validar o hardware e documentar recuperação.

## 1. Objetivo e escopo

Construir o **NeonByte**, um projeto open-source composto por firmware próprio para um pequeno display Wi-Fi e um agente desktop que consulta o Spotify. O dispositivo apresenta **exatamente duas telas**:

1. **Spotify Now Playing:** capa do álbum, título, artista e progresso da faixa.
2. **GIF fullscreen:** animação ocupando toda a tela, reproduzida em loop sem elementos sobrepostos.

**Comportamento padrão:** reprodução ativa no Spotify → Spotify; pausa, ausência de reprodução ou indisponibilidade do agente → GIF. O usuário pode escolher `auto`, `spotify` ou `gif` manualmente. No modo `spotify` sem música, mostrar um estado de espera discreto (não inventar faixa). O GIF deve permanecer disponível após reiniciar o relógio; se o PC desligar e o display ainda estiver energizado, o GIF continua.

### Fora de escopo para a primeira versão

- Home Assistant, MQTT, banco de dados, Docker, nuvem obrigatória, aplicativo móvel, controle de reprodução ou integração com outros players.
- Editor de GIF, múltiplos GIFs, transições sofisticadas ou vários temas.
- Áudio tocado no relógio: ele **mostra** informações, não reproduz músicas.
- Compatibilidade com variantes não verificadas do SD PRO.

## 2. Premissas que precisam de validação

- **Não assumir** chip, pinagem SPI, driver do LCD, backlight, orientação, tamanho de flash, esquema de partições, sistema de arquivos ou layout OTA só pelo nome comercial do dispositivo.
- A tela esperada é **240 × 240**; validar resolução, rotação e cores no hardware real.
- Confirmar se existe meio confiável de salvar/restaurar o firmware original e recuperar o dispositivo (ex.: conexão serial e modo bootloader) antes de flash.
- Investigar limitações de RAM, armazenamento, tamanho máximo de firmware, velocidade de desenho e desgaste de flash.
- Confirmar exigências atuais da Spotify Web API (escopos, modalidade de app, regras de rate limit e credenciais) na documentação oficial durante a implementação.
- Verificar as licenças de bibliotecas, fontes e assets adicionados ao projeto, respeitando atribuições.

**Marco bloqueante:** sem evidência técnica para identificar e recuperar o dispositivo, manter o desenvolvimento no simulador; não adivinhar configurações de hardware.

## 3. Arquitetura proposta

```text
Spotify Web API
      |
      | OAuth + consulta HTTPS (somente no computador)
      v
NeonByte Agent (Node.js + TypeScript)
  - OAuth, refresh token e armazenamento seguro
  - polling e normalização de estado
  - conversão/cache da arte do álbum
  - conversão/otimização do GIF
  - configuração web somente em localhost
  - comunicação e sincronização com o relógio
      |
      | HTTP local autenticado / Wi-Fi
      v
NeonByte Firmware (C++ / PlatformIO, plataforma a confirmar)
  - Wi-Fi e pareamento local
  - renderização da tela Spotify
  - player de animação otimizada fullscreen
  - armazenamento persistente do GIF e configurações
  - fallback em perda de conectividade
```

O agente inicia automaticamente **no login do usuário** (Windows 11 e Fedora), sem precisar manter terminal aberto. Não é necessário iniciá-lo antes do login. A conexão local e o Spotify podem falhar temporariamente; o sistema deve se recuperar sem intervenção.

### Responsabilidades

| Componente | Responsabilidades | Não deve fazer |
|---|---|---|
| Agente | OAuth, Spotify, polling, cache, conversão de mídia, UI de configuração, envio de atualizações | Guardar segredos no firmware; exigir container ou banco |
| Firmware | Exibir cenas, atualizar progresso localmente, reproduzir GIF, persistir assets e responder a comandos | Chamar Spotify diretamente; depender de Internet para GIF |
| Simulador | Reproduzir a lógica visual e testar protocolos antes do flash | Fingir que testes no browser validam o hardware |

## 4. Estrutura do repositório

```text
NeonByte/
├── PLANNING.md
├── README.md
├── LICENSE
├── AGENTS.md
├── .gitignore
├── docs/
│   ├── hardware.md
│   ├── protocol.md
│   ├── development.md
│   ├── installation.md
│   └── recovery.md
├── agent/
│   ├── package.json
│   ├── src/
│   │   ├── main.ts
│   │   ├── spotify/
│   │   ├── device/
│   │   ├── media/
│   │   ├── config/
│   │   └── web/
│   └── tests/
├── simulator/
│   └── ...
├── firmware/
│   ├── platformio.ini
│   ├── include/
│   ├── src/
│   │   ├── main.cpp
│   │   ├── display/
│   │   ├── scenes/
│   │   ├── network/
│   │   └── storage/
│   └── test/
└── assets/
    └── samples/
```

A estrutura pode ser ajustada se houver justificativa registrada. Evitar abstrações prematuras e dependências pesadas.

## 5. Comportamento funcional

### 5.1 Modos de tela

| Configuração | Spotify tocando | Pausado/sem faixa/agente offline |
|---|---|---|
| `auto` (padrão) | Spotify | GIF |
| `spotify` | Spotify | Estado de espera da tela Spotify |
| `gif` | GIF | GIF |

- Em `auto`, detectar reprodução com base no estado confirmado pela API; não inferir que uma janela do Spotify aberta significa reprodução.
- Aplicar **timeout de atualização** configurável: se o agente deixar de enviar heartbeat por um período definido (exemplo inicial: 45 s), o firmware volta ao GIF.
- Quando o Spotify pausar, fazer transição para GIF sem exigir reboot.
- A troca manual deve persistir após reinicialização.

### 5.2 Spotify

- Exibir capa em proporção correta, título e artista com truncamento/scroll controlado e barra de progresso.
- Progresso avança no firmware entre sincronizações e é corrigido quando chegar novo timestamp da reprodução.
- Polling inicial sugerido: **15 s** (configurável); tratar `429` e `Retry-After`, falhas de rede, `204 No Content`, expiração e renovação de tokens.
- Atualizar capa apenas quando a faixa/arte mudar; transferir dados em formato apropriado ao LCD.
- Não exibir tokens ou segredos em logs, URLs compartilhadas ou respostas do dispositivo.
- Fluxo Spotify recomendado para app local: **Authorization Code com PKCE**, com redirect em loopback permitido pela plataforma e escopo mínimo de leitura da reprodução. Conferir regras atualizadas antes de codificar.

### 5.3 GIF fullscreen

- Interface do agente permite selecionar um GIF e visualizar prévia 240 × 240.
- Converter para dimensões finais 240 × 240: política padrão `cover` (preencher e recortar), oferecendo alternativa `contain` apenas se realmente necessária.
- Preservar temporização dos quadros sempre que possível; reduzir FPS, paleta ou número de frames conforme orçamento real de flash/RAM.
- **Não pressupor que o ESP8266 decodificará GIF original em tempo real.** Agente gera um formato de animação próprio/otimizado e documentado, adequado a leitura sequencial/streaming da flash.
- Validar integridade (tamanho, versão, checksum) antes de substituir a animação atual. Gravação atômica ou procedimento recuperável para não perder o GIF funcional em caso de falha.
- GIF deve tocar em loop sem conexão com o computador, desde que o dispositivo esteja energizado.

### 5.4 Aplicativo local de configuração

Interface acessível somente em `http://localhost:8787` (porta configurável) com:

- Estado da conexão com o dispositivo.
- Botão **Conectar Spotify** / reconectar.
- Prévia de Spotify usando dados mock ou dados atuais.
- Upload de GIF e prévia de como ficará na tela.
- Seletor `Auto` / `Spotify` / `GIF`.
- Endereço do dispositivo ou descoberta local (somente se descoberta for confiável).
- Mensagens de erro acionáveis, sem mostrar segredos.

**Segurança local:** bind apenas em `127.0.0.1`, validação de inputs, proteção de endpoints mutáveis contra origens não autorizadas (CSRF/origin), limites de tamanho de upload. Não guardar credenciais em texto puro dentro do repositório; preferir cofre do sistema, com fallback documentado e permissões restritas.

## 6. Protocolo agente ↔ firmware (proposta inicial)

O protocolo abaixo **é especificação a implementar**, não endpoints já existentes. Definir formato exato em `docs/protocol.md`, com versionamento (`v1`). Autenticar operações de alteração por token de pareamento, armazenado no agente e no dispositivo, sem expor o token em logs.

| Método | Endpoint | Uso |
|---|---|---|
| `GET` | `/api/v1/status` | Firmware, versão do protocolo, IP, espaço livre, modo e cena ativa |
| `PUT` | `/api/v1/mode` | Atualizar `auto`, `spotify` ou `gif` |
| `PUT` | `/api/v1/spotify` | Atualizar metadados, `isPlaying`, duração, progresso e timestamp |
| `PUT` | `/api/v1/cover` | Enviar imagem otimizada com identificação da faixa |
| `PUT` | `/api/v1/animation` | Enviar arquivo otimizado de animação com validação de integridade |
| `POST` | `/api/v1/heartbeat` | Renovar estado de presença do agente |

Exemplo de payload para `PUT /api/v1/spotify`:

```json
{
  "trackId": "example-track-id",
  "title": "Example Track",
  "artist": "Example Artist",
  "isPlaying": true,
  "durationMs": 180000,
  "progressMs": 42000,
  "sampledAtUnixMs": 1790000000000
}
```

Especificar e testar: limites de tamanho e texto, versão, erros HTTP, autenticação, timeout, reconnect, idempotência, checksum e comportamento se a capa chegar antes/depois dos metadados. O relógio não deve tentar abrir URLs HTTPS de capa diretamente.

> **Segurança:** HTTP local com token protege contra alterações acidentais/não autorizadas em redes confiáveis, mas **não cifra** o tráfego. Documentar a limitação; para redes não confiáveis, avaliar alternativa segura em evolução futura.

## 7. Etapas de implementação

Cada etapa contém **entrega, tarefas, testes, aceite e dependências**. Só avançar quando os critérios de aceite forem satisfeitos e houver aprovação explícita do mantenedor.

### Etapa 1 — Fundação e investigação (sem tocar no relógio)

**Entregáveis:** estrutura do repositório, `README.md`, `AGENTS.md`, documentação inicial, contratos, testes básicos e levantamento de hardware.

- [x] Criar monorepo e convenções de scripts, estilo de código e CI básica.
- [x] Registrar em `docs/hardware.md` evidências do modelo (fotos, interface original, link oficial de firmware/repositório, identificação da placa e hardware quando disponível).
- [x] Levantar riscos de pinagem, bootloader, flash, OTA, filesystem e recuperação; marcar desconhecidos como `PENDENTE`, sem adivinhar.
- [x] Especificar fluxos `auto`/`spotify`/`gif`, modelo de dados e API v1.
- [x] Definir orçamento preliminar de recursos a ser medido no hardware (flash, RAM, FPS), sem números inventados.
- [x] Preparar `.env.example` apenas com configurações não secretas e placeholders.

**Aceite:** repositório abre, lint/testes iniciais executam, contratos e pendências estão documentados; nenhuma integração/flash iniciado.

### Etapa 2 — Agente Spotify (sem firmware)

**Entregáveis:** aplicação Node.js + TypeScript executável, autenticação, leitura e normalização do estado de reprodução.

- [x] Configurar projeto TS, testes unitários, logs e tratamento de erros.
- [x] Implementar OAuth Spotify Authorization Code + PKCE, callback em loopback e armazenamento seguro de refresh token.
- [x] Consultar reprodução atual com o menor escopo aplicável, tratar `204`, `401`, `429`/`Retry-After`, offline e token expirado.
- [x] Implementar polling configurável (valor inicial 15 s), comparador para não reenviar informações idênticas e cache de metadados.
- [x] Criar adaptador mock para desenvolver sem conta Spotify e sem chamadas externas em testes.
- [x] Expor estado interno ao simulador por interface local definida e testada (sem expor credenciais).

**Aceite:** fluxos OAuth e refresh cobertos por testes com mocks; validação de autenticação real pendente até configurar uma conta Spotify; mock reproduz play/pause/troca; testes passam; segredos não são enviados ao logger.

**Revisão corretiva:** `make check` passou localmente com Node.js 22.12.0 e 24.21.0. A CI foi configurada para ambas as versões principais; a execução remota dessa alteração ainda depende de um novo push. A deduplicação considera o avanço esperado e corrige desvios superiores a 2 segundos; a integração com o relógio permanece pendente da etapa correspondente.

### Etapa 3 — Simulador e interface local (sem flash)

**Entregáveis:** prévia fiel 240 × 240 e painel local funcional.

- [x] Criar simulador das duas cenas com escala sem alterar a composição lógica de 240 × 240.
- [x] Spotify: capa, título, artista, barra de progresso e estado sem reprodução.
- [x] GIF: upload, validação, preview fullscreen, loop, política de corte e mensagem clara para GIF inviável.
- [x] Implementar modos `auto`/`spotify`/`gif` e lógica de timeout do agente no simulador.
- [x] Interface local `localhost:8787` para conexão Spotify, modo, GIF e status.
- [x] Implementar conversão de GIF e capa para formato intermediário proposto, com testes de integridade e limites.

**Aceite:** com mock, iniciar/parar/trocar músicas altera cenas corretamente; GIF usa todo o frame; upload inválido é rejeitado; tudo funciona sem o dispositivo.

**Validação desta etapa:** `npm run check` passou com testes de contrato, mídia, cenas, modos, OAuth integrado e upload; a página e os assets foram verificados via `http://localhost`. A prévia é local e não valida a unidade física.

### Etapa 4 — Firmware próprio e validação do hardware

**Bloqueio obrigatório antes da gravação:** confirmar chip, pinout, alimentação, display, resolução, backlight, flash, partitions, bootloader, interface serial, backup do original e recuperação. Se algum item crítico não puder ser confirmado, não executar flash.

**Entregáveis:** projeto PlatformIO compilável, cenas, rede, storage e API implementada, testes de bancada.

- [ ] Documentar hardware verificado e preparar procedimento testável de backup/restore.
- [ ] Configurar placa/board, framework, flags e esquema de partições baseado em evidências.
- [ ] Inicializar LCD, orientação, cores e backlight com teste visual mínimo.
- [ ] Configurar Wi-Fi de maneira recuperável, sem credenciais hardcoded.
- [ ] Implementar API HTTP local e autenticação/pareamento.
- [ ] Desenhar cena Spotify e renderizar imagem recebida de forma incremental/compatível com RAM.
- [ ] Ler e animar frames otimizados de storage com uso limitado de memória, temporização e loop.
- [ ] Persistir modo e asset, validar checksum e recuperar último asset válido após upload interrompido.
- [ ] Implementar watchdog/fallback GIF após perda do agente; impedir que falhas de Wi-Fi bloqueiem renderização.
- [ ] Medir RAM, espaço livre e FPS reais; ajustar codec/limites/documentação.

**Aceite:** build reproduzível; gravação somente com autorização; dispositivo recuperável; GIF roda sozinho e interface responde, sem travamentos observáveis em testes prolongados.

### Etapa 5 — Integração ponta a ponta

**Entregáveis:** agente ↔ SD PRO conectados pela LAN com cenas sincronizadas.

- [ ] Implementar client HTTP no agente para endpoints da versão `v1`.
- [ ] Pairing e configuração de IP/hostname do dispositivo; lidar com IP alterado.
- [ ] Enviar capa somente quando necessário; garantir ordem/consistência de metadados e imagem.
- [ ] Implantar upload de animação com progresso, retry seguro e verificação no dispositivo.
- [ ] Implementar heartbeat, desconexão, reconexão, timeout e sincronização após reboot.
- [ ] Testar modos manuais, mudança de música, pause/resume e fim de sessão.
- [ ] Testar Wi-Fi instável, PC suspenso, dispositivo reiniciado, internet indisponível e GIF grande.

**Aceite:** alternância automática estável; sem intervenção manual após perda/retorno de rede; GIF persiste; Spotify não interfere no GIF quando modo manual está ativo.

### Etapa 6 — Inicialização automática, distribuição e qualidade

**Entregáveis:** instaladores/scripts de inicialização, instruções para Windows/Fedora e versão de lançamento.

- [ ] Windows 11: registrar tarefa no Agendador de Tarefas para iniciar o agente no **login**; logs acessíveis, sem janela de terminal permanente, com instalação/remoção documentadas.
- [ ] Fedora: criar serviço `systemd --user` com inicialização no login, reinício em falhas e comandos de habilitar/desabilitar.
- [ ] Evitar múltiplas instâncias simultâneas, registrar erros sem expor tokens, implementar desligamento limpo.
- [ ] Empacotar agente ou documentar instalação reproducível (Node LTS suportado, dependências e configuração).
- [ ] Completar `README.md`, `docs/installation.md`, `docs/recovery.md`, screenshots do simulador e limites conhecidos.
- [ ] Adicionar workflow CI (lint, build, testes) e versão `0.1.0` após checklist final.

**Aceite:** reiniciar PC e fazer login ativa automaticamente o agente; Spotify é reconectado quando possível; falhas ficam visíveis; procedimento de desinstalação funciona.

## 8. Plano de testes

### Testes automatizados mínimos

- Agente: estados Spotify, refresh token, 204/401/429, retry, timeout, deduplicação de mudanças, cache de capa.
- Mídia: GIF inválido, dimensões incorretas, arquivo grande, ausência de frames, checksum, timing de frames.
- Protocolo: payload inválido, modo desconhecido, token incorreto, conexão interrompida, uploads incompletos e versão incompatível.
- Simulador: mudança `auto ↔ spotify ↔ gif`, UI 240 × 240 e atualização de progresso.

### Testes manuais com hardware real

- Display inicia e renderiza cores/orientação corretamente.
- GIF de 240 × 240 funciona em loop e sobrevive ao reboot.
- Spotify atualiza faixa/capa sem piscadas excessivas.
- PC suspende/desliga; relógio volta ao GIF se continuar alimentado.
- Wi-Fi desliga/volta; agente reconecta sozinho.
- Reiniciar dispositivo durante transferência não corrompe permanentemente configuração ou asset anterior.
- 1–2 horas de execução contínua sem reset inesperado (aumentar duração no teste de release).

## 9. Critérios gerais de qualidade

- Firmware não pode conter credenciais Spotify.
- Todos os endpoints mutáveis exigem autenticação local, com exceção de eventual fluxo de pareamento documentado.
- UI do agente não é exposta em interfaces de rede externa por padrão.
- Repositório não contém tokens, `client_secret`, senhas de Wi-Fi ou arquivos `.env` reais.
- Dependências externas com licença compatível com MIT ou obrigações documentadas.
- Não introduzir banco, container, cloud, autenticação multiusuário ou recursos não solicitados.
- Código testável, builds reproduzíveis e documentação de recuperação.

## 10. Definição de pronto (MVP)

- [ ] Na primeira inicialização, usuário consegue configurar Wi-Fi, parear relógio e conectar Spotify.
- [ ] Spotify ativo mostra capa, artista, música e progresso.
- [ ] Spotify pausado/sem reprodução ou agente indisponível mostra GIF em `auto`.
- [ ] GIF personalizado ocupa 240 × 240 e roda em loop mesmo quando PC desliga (com relógio energizado).
- [ ] Modos `auto`, `spotify` e `gif` podem ser selecionados e persistem.
- [ ] Agente inicia no login do Windows 11 e do Fedora.
- [ ] Documentação de instalação, troubleshooting, backup e recuperação concluída.
- [ ] Sem credenciais em logs ou versionamento; testes automatizados e testes com hardware aprovados.

## 11. Instruções para GitHub Copilot (Agent Mode)

1. Leia **todo** este documento, `AGENTS.md` e os arquivos existentes antes de alterar código.
2. Execute **somente a etapa explicitamente autorizada**. Não antecipe etapas.
3. Antes de implementar, apresente: resumo da etapa, arquivos impactados, riscos e como será testada.
4. Não invente comportamento de bibliotecas, endpoints, pinagem ou memória: confirme em documentação/código/hardware.
5. Priorize solução pequena e funcional, com testes correspondentes.
6. Ao final de cada etapa, execute testes/lint/build relevantes, documente resultados e pendências.
7. Atualize o checklist deste arquivo **somente com itens realmente concluídos e verificados**.
8. Não executar flash, OTA, erase, alteração de partição ou operação destrutiva sem autorização explícita do mantenedor.
9. Pare ao concluir a etapa e solicite autorização para a próxima.

**Instrução ao agente de código:**

> Leia o `PLANNING.md` integralmente e execute somente a etapa explicitamente autorizada pelo mantenedor. A Etapa 1 está concluída. A Etapa 2 foi implementada; validação OAuth real ainda depende de credenciais. Não inicie a Etapa 3 sem autorização explícita.

## 12. Registro de decisões

| Decisão | Escolha inicial | Revisar quando |
|---|---|---|
| Nome | NeonByte | — |
| Licença | MIT | Antes de publicar dependências/arte de terceiros |
| Agente | Node.js + TypeScript | Se requisitos mudarem |
| Firmware | C++ + PlatformIO | Após validar chip real |
| Comunicação | HTTP local + token | Se modelo de ameaça exigir criptografia |
| Modos | `auto`, `spotify`, `gif` | Após MVP |
| Polling Spotify | 15 s, ajustável | Após medir limites e latência |
| GIF offline | Asset persistente no dispositivo | Após medir flash e performance |
| Boot do agente | No login do usuário | Se houver necessidade de funcionar sem login |
| Interface de configuração | `localhost:8787` | Conflito de porta ou segurança |

---

**Nota:** este planejamento orienta a implementação; decisões técnicas dependentes do hardware e regras atuais da API Spotify exigem confirmação durante as etapas correspondentes. A interface web original do relógio, por si só, não comprova compatibilidade com um firmware específico.
