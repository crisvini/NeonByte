# Contrato HTTP local v1

**Estado:** especificação inicial; ainda não há servidor, cliente ou firmware implementado para o dispositivo. As rotas `/api/v1` descrevem o contrato pretendido, não endpoints existentes. As rotas `/api/*` da interface local do agente são privadas ao simulador e não fazem parte deste contrato.

## Transporte e compatibilidade

- Base HTTP local; host, porta do dispositivo e método de descoberta: PENDENTE.
- Prefixo de rotas: /api/v1.
- JSON usa UTF-8 e Content-Type: application/json.
- A versão retornada por GET /api/v1/status deve ser v1. O cliente deve parar de enviar atualizações se a versão não for compatível.
- Os schemas são fechados (additionalProperties: false). Alterações incompatíveis exigem uma nova versão do caminho.
- HTTP local com token não cifra o tráfego. Usar somente em uma LAN confiável; não expor o dispositivo à Internet.

## Autenticação

Todas as rotas mutáveis exigem Authorization: Bearer {token}: modo, Spotify, capa, animação e heartbeat. GET /api/v1/status é somente leitura e não exige token. Tokens não podem aparecer em logs, URLs ou respostas.

Geração, pareamento inicial, armazenamento seguro e recuperação do token: PENDENTE. Não há exceção de pareamento implementada.

## Modos e seleção de tela

O modo persistido é exatamente um destes valores:

- **auto**: exibe Spotify somente quando há atualização recente do agente e isPlaying é verdadeiro; caso contrário, GIF.
- **spotify**: permanece na tela Spotify; sem faixa ativa ou com dados/heartbeat vencidos, mostra um estado de espera discreto.
- **gif**: exibe somente o GIF fullscreen.

Interpretação inicial do timeout: heartbeat ausente por 45 segundos torna o agente indisponível. Esse estado faz auto voltar ao GIF; o modo manual spotify continua na tela de espera, conforme a matriz de modos do planejamento. O modo padrão é auto; a escolha manual persiste após reinicialização.

O intervalo de polling Spotify sugerido é 15 segundos e será configurável no agente. A decisão de manter spotify em espera quando o heartbeat expira concilia a matriz de modos com o timeout geral do planejamento; deve ser revista se o mantenedor desejar que o timeout sobreponha também o modo manual.

| Modo | Agente recente e faixa tocando | Sem faixa, pausado ou agente vencido |
|---|---|---|
| auto | Spotify Now Playing | GIF fullscreen |
| spotify | Spotify Now Playing | Tela Spotify em espera |
| gif | GIF fullscreen | GIF fullscreen |

activeScene representa uma das duas telas, spotify ou gif; o estado de espera pertence à tela Spotify e não cria uma terceira tela.

## Modelo Spotify

PUT /api/v1/spotify recebe o objeto definido em [now-playing.schema.json](../contracts/v1/now-playing.schema.json):

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

progressMs deve ser limitado a durationMs pelo agente. O firmware avança o progresso localmente entre atualizações e corrige o valor ao receber outro timestamp. Os limites iniciais de texto são 256 caracteres para trackId, title e artist; devem ser mantidos alinhados entre schemas, agente e firmware.

## Rotas

| Método | Rota | Corpo/headers | Sucesso |
|---|---|---|---|
| GET | /api/v1/status | Sem corpo | 200 e objeto conforme [status.schema.json](../contracts/v1/status.schema.json). |
| PUT | /api/v1/mode | JSON conforme [mode.schema.json](../contracts/v1/mode.schema.json) | 204; modo persistido. |
| PUT | /api/v1/spotify | JSON conforme [now-playing.schema.json](../contracts/v1/now-playing.schema.json) | 204; estado atualizado. |
| PUT | /api/v1/cover | Bytes binários, X-Track-Id e X-Content-SHA256 | 204 após validação e gravação. Formato de imagem e limite de bytes: PENDENTE. |
| PUT | /api/v1/animation | Bytes binários e X-Content-SHA256 | 204 após validação e gravação. Codec, versão de formato e limite de bytes: PENDENTE. |
| POST | /api/v1/heartbeat | Sem corpo | 204; registra a presença no momento da recepção. |

O formato da capa e da animação depende do formato de pixels, armazenamento, RAM e desempenho confirmados para o hardware. Até essa decisão, as rotas binárias são envelopes propostos e não estão prontas para interoperabilidade. X-Content-SHA256 é SHA-256 hexadecimal minúsculo do corpo completo. Uploads devem ser validados antes de substituir o asset funcional anterior.

Uma capa recebida antes dos metadados pode ser armazenada pela chave X-Track-Id, mas só pode aparecer junto da faixa com o mesmo trackId. Uma capa de faixa anterior não deve ser mostrada como se pertencesse à faixa atual.

## Erros HTTP

Erros JSON seguem [error.schema.json](../contracts/v1/error.schema.json). O campo message deve ser acionável e não pode conter tokens ou outros segredos.

| HTTP | Código estável | Uso |
|---|---|---|
| 400 | invalid_request | JSON, parâmetro ou header ausente/malformado. |
| 401 | unauthorized | Token ausente ou inválido em rota mutável. |
| 404 | not_found | Rota ou recurso desconhecido. |
| 409 | conflict | Conflito com o estado atual ou upload concorrente. |
| 413 | payload_too_large | Corpo excede o limite configurado; limite numérico: PENDENTE. |
| 415 | unsupported_media_type | Tipo/formato não suportado. |
| 422 | invalid_content | Conteúdo, checksum ou semântica inválida. |
| 500 | internal_error | Falha interna sem detalhes sensíveis. |

## Segurança e limites pendentes

- Não há TLS no desenho inicial; restringir o tráfego à rede local confiável.
- Definir pareamento, geração e armazenamento do token antes de implementar rotas mutáveis.
- Definir porta, limites de corpo e formatos binários com evidência de hardware antes de implementar firmware ou integração.
- Rejeitar modo desconhecido, payload inválido, checksum incorreto e upload incompleto; preservar o último asset válido.
- O protocolo não inclui comandos para controlar reprodução Spotify.
