# Instruções para agentes de código

1. Leia todo o PLANNING.md, este arquivo e a documentação relacionada antes de alterar o projeto.
2. Execute somente a etapa explicitamente autorizada pelo mantenedor. Não antecipe etapas futuras.
3. Trate hardware, pinagem, memória, flash, partições, OTA e recuperação sem evidência como PENDENTE. Não deduza compatibilidade pelo nome comercial.
4. Não compile para uma placa presumida nem execute flash, OTA, erase, alteração de partições ou qualquer operação no dispositivo sem autorização explícita.
5. Nunca versione tokens, segredos, senhas, arquivos .env reais ou credenciais Spotify. Use .env.example somente para nomes e placeholders não secretos.
6. Mantenha os contratos em contracts/v1/ alinhados com docs/protocol.md; atualize os exemplos e testes quando um contrato mudar.
7. Rode npm run check para validar Markdown e contratos antes de concluir uma etapa.
8. Marque no PLANNING.md somente tarefas concluídas e verificadas. Ao chegar ao limite da etapa autorizada, pare e peça autorização antes de continuar.

## Convenções iniciais

- UTF-8 e finais de linha LF.
- Markdown com títulos hierárquicos, listas com hífen e blocos de código cercados.
- Não adicione dependências de runtime sem necessidade documentada.
- Código de agente, firmware e simulador segue sem implementação até a autorização de sua etapa.
