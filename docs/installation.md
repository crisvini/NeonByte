# Instalação

**Estado:** configuração local do agente Spotify disponível; início automático no login, simulador, interface gráfica e firmware continuam PENDENTES.

## Agente Spotify (Windows 11 e Fedora)

1. Instale Node.js 22 ou superior.
2. No Fedora, confirme que uma sessão Secret Service está ativa (GNOME Keyring ou KWallet). No Windows, o agente usa o Credential Manager integrado.
3. Na raiz do repositório, instale as dependências com `npm ci` e `npm ci --prefix agent`.
4. Copie `.env.example` para `.env`, defina `SPOTIFY_CLIENT_ID` e mantenha `SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback`.
5. No Spotify Developer Dashboard, cadastre o redirect URI exatamente como configurado. O aplicativo usa PKCE e não precisa de `client_secret`.
6. Compile e autorize:

   ```sh
   npm --prefix agent run build
   npm --prefix agent run auth
   ```

   Abra no navegador a URL exibida pelo comando e conceda a leitura da reprodução atual. O retorno OAuth é recebido somente por `127.0.0.1`.

7. Inicie o polling com `npm --prefix agent run start`. O padrão é 15 segundos; ajuste `SPOTIFY_POLL_INTERVAL_MS` em `.env` se necessário.

O refresh token é armazenado no cofre nativo do sistema. Se o cofre não estiver disponível, a autenticação falha sem gravar o token em arquivo. O agente não é registrado para iniciar no login nesta etapa.

Estas instruções não instalam nem configuram o dispositivo. Qualquer firmware depende da identificação do hardware, backup/restauração testáveis e autorização explícita para gravação.
