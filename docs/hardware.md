# Investigação de hardware

**Estado:** preliminar. Nenhuma unidade foi inspecionada fisicamente nesta etapa. Todas as propriedades de hardware da unidade do projeto permanecem PENDENTE.

## Fontes encontradas

| Fonte | O que informa | Como será usada |
|---|---|---|
| [Repositório SD_PRO da JUZIPi-tech](https://github.com/JUZIPi-tech/SD_PRO) | O repositório sob a organização JUZIPi-tech contém binários SD Pro e o manual Smart Clock V1.2.1. | Referência pública possivelmente ligada ao fornecedor; vínculo formal e correspondência com esta unidade não foram confirmados. Nenhum binário foi baixado, enviado ou executado. |
| [Projeto comunitário homeassistant-minidisplay](https://github.com/piotrkochan/homeassistant-minidisplay) | O mantenedor relata ter testado um JUZIPi SD PRO com ESP8266/ESP-12F, 4 MB de flash e LCD ST7789 de 240 × 240. | Relato independente de uma unidade; não comprova a revisão ou a configuração do hardware deste projeto. |

Não há fotos do exemplar, identificação de revisão da placa ou captura da interface original anexadas a este repositório. A resolução 240 × 240 vem do planejamento e do relato comunitário, portanto continua sendo alvo esperado, não medição confirmada.

## Identificação da unidade

| Item | Estado | Evidência necessária |
|---|---|---|
| Modelo e revisão exatos no rótulo | PENDENTE | Foto do rótulo e do gabinete. |
| Fotos da placa e marcações dos componentes | PENDENTE | Fotos nítidas da placa; não abrir o dispositivo se isso exigir risco ou dano. |
| MCU, módulo e frequência | PENDENTE | Marcações legíveis ou documentação técnica ligada à revisão exata. |
| Controlador, resolução, rotação e cores do LCD | PENDENTE | Manual aplicável à revisão e confirmação visual/elétrica em bancada autorizada. |
| Pinagem SPI, chip select, reset e backlight | PENDENTE | Esquema ou firmware original correspondente à revisão. |
| Alimentação e limites elétricos | PENDENTE | Especificação do fornecedor e medição segura. |
| Flash, partições e sistema de arquivos | PENDENTE | Identificação da unidade e leitura técnica não destrutiva. |
| Bootloader, serial e modo de recuperação | PENDENTE | Procedimento documentado e testado para a revisão exata. |
| Firmware original e procedimento de backup/restore | PENDENTE | Imagem correspondente e restauração testável antes de qualquer gravação. |
| Interface e versão do firmware original | PENDENTE | Capturas da interface e versão exibida no dispositivo. |

## Riscos e orçamento preliminar

| Recurso ou risco | Estado |
|---|---|
| RAM livre em operação e pico durante desenho/upload | PENDENTE — medir no hardware identificado |
| Flash livre depois do firmware e sistema de arquivos | PENDENTE — medir no hardware identificado |
| Tamanho máximo de firmware e layout OTA | PENDENTE — confirmar sem gravar |
| FPS de cada tela e custo de atualização | PENDENTE — medir em bancada |
| Limite de tamanho, quadros e temporização da animação | PENDENTE — definir com medições de RAM, flash e desempenho |
| Método de recuperação após falha de boot | PENDENTE — documentar e testar antes de flash |

Nenhum número de capacidade ou desempenho é assumido. O valor de 240 × 240 é apenas uma dimensão esperada no planejamento.

## Regra de segurança

Até que MCU, pinagem, alimentação, display, flash, partições, bootloader, backup do original e recuperação estejam confirmados, o trabalho permanece no contrato e no simulador. Não gravar firmware, executar OTA ou apagar/alterar partições com base apenas em referências de outras unidades.
