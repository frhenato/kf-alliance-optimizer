# Alliance Deck Optimizer - Serverless

Otimizador de Alliance Decks para Decks of KeyForge com arquitetura serverless.

(Visite decksofkeyforge.com.br e considere se tornar um Patreon).

## Arquitetura

```
┌─────────────────────────────────────────────────────┐
│  FRONTEND (browser)                                  │
│  - Busca decks/cartas via proxy                     │
│  - Processa combinações localmente                  │
│  - Calcula SAS com synergy-engine.js                │
│  - Logs/progresso em tempo real                     │
└───────────────────┬─────────────────────────────────┘
                    │ GET /api/proxy?path=/v1/...
┌───────────────────▼─────────────────────────────────┐
│  BACKEND (proxy serverless)                          │
│  - Apenas repassa chamadas para DoK API              │
│  - Resolve CORS                                      │
│  - ~100 linhas de código                             │
└─────────────────────────────────────────────────────┘
```

## Vantagens

- **Logs instantâneos**: Sem buffering de HTTP streaming
- **Backend mínimo**: Apenas proxy, pode ser serverless
- **Hospedagem barata**: Funciona com Vercel/Netlify/Cloudflare gratuitos
- **Offline após carregar dados**: Todo processamento é local

## Desenvolvimento Local

```bash
npm install
npm run dev
# Acesse http://localhost:3001
```

## Deploy

### Vercel

1. Conecte o repositório ao Vercel
2. Deploy automático

### Netlify

1. Build command: (vazio)
2. Publish directory: `public`
3. Functions directory: `api`

### Cloudflare Pages

1. Build command: (vazio)
2. Build output: `public`
3. Use Functions para o proxy

## Estrutura

```
├── api/
│   └── proxy.js          # Serverless function (proxy DoK API)
├── public/
│   ├── index.html        # UI principal
│   ├── js/
│   │   ├── optimizer.js      # Lógica de processamento
│   │   └── synergy-engine.js # Cálculo de SAS
│   └── imgs/             # Ícones das casas
├── server.js             # Servidor de desenvolvimento
├── package.json
└── vercel.json           # Config Vercel
```

## Como funciona

1. **Busca decks**: Frontend chama `/api/proxy?path=/v1/my-decks`
2. **Proxy**: Backend repassa para `decksofkeyforge.com/public-api/v1/my-decks`
3. **Processamento**: Frontend calcula combinações e SAS
4. **Resultado**: Exibe as 500 melhores alianças por expansão

## Licença

MIT
