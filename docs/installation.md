# Instalação

**Estado:** agente Spotify e interface local com simulador disponíveis; início automático no login e firmware continuam PENDENTES.

## Agente Spotify (Windows 11 e Fedora)

1. Instale Node.js 22 ou superior.
2. No Fedora, confirme que uma sessão Secret Service está ativa (GNOME Keyring ou KWallet). No Windows, o agente usa o Credential Manager integrado.
3. Na raiz do repositório, instale as dependências com `npm ci` e `npm ci --prefix agent`.
4. Copie `.env.example` para `.env`, defina `SPOTIFY_CLIENT_ID` e mantenha `SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback`. Se alterar a porta, ajuste `NEONBYTE_PORT` para o mesmo valor.
5. No Spotify Developer Dashboard, cadastre o redirect URI exatamente como configurado. O aplicativo usa PKCE e não precisa de `client_secret`.
6. Compile o agente e inicie a interface local:

   ```sh
   npm --prefix agent run build
   npm --prefix agent run start
   ```

   Abra [http://localhost:8787](http://localhost:8787) e use **Conectar Spotify**. O retorno OAuth é recebido pelo mesmo servidor, somente em `127.0.0.1`. O comando `npm --prefix agent run auth` continua disponível para executar a autorização sem abrir o painel.

O agente inicia o polling junto com a interface. O intervalo padrão é 15 segundos; ajuste `SPOTIFY_POLL_INTERVAL_MS` em `.env` se necessário.

O refresh token é armazenado no cofre nativo do sistema. Se o cofre não estiver disponível, a autenticação falha sem gravar o token em arquivo. O agente não é registrado para iniciar no login nesta etapa.

Sem um `SPOTIFY_CLIENT_ID` válido, o agente inicia em modo de demonstração para testar play, pausa, troca de faixa, GIF e os modos de tela sem chamadas externas. Com Client ID configurado, a interface oferece o controle de dados de demonstração. O GIF deve ser animado e ter até 8 MiB, 20 quadros, 30 segundos de duração, 1.048.576 pixels por dimensão lógica ou descritor de quadro e 4.194.304 pixels somados entre os descritores. A prévia é temporária e fica em memória até o agente encerrar.

Estas instruções não instalam nem configuram o dispositivo. Qualquer firmware depende da identificação do hardware, backup/restauração testáveis e autorização explícita para gravação.
