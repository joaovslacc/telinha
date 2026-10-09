# Protocolo e API do cliente

A UI (`public/ui.js`) só conversa com a API `window.Telinha`, implementada em `public/client.js`.
Quer trocar o visual? Reescreva `index.html`/`style.css`/`ui.js` usando só a API abaixo e o resto continua funcionando.

Arquitetura: mesh P2P WebRTC (um `RTCPeerConnection` por par; limite de pessoas por sala opcional via `MAX_PEERS`), sinalização por
WebSocket em `/ws` e TURN (coturn) para quem está atrás de NAT difícil.

## API do cliente no navegador (`window.Telinha`)

```js
Telinha.canShare            // boolean: navigator.mediaDevices.getDisplayMedia existe (false em celular)
Telinha.randomCode()        // string: código novo, 6 chars [a-z0-9] sem ambíguos (ex.: "k7m2qx")
const room = Telinha.join({ name, code })   // conecta e entra; devolve Room imediatamente

room.on(evento, fn)      // assina; retorna função para desassinar
room.startShare()        // Promise<MediaStream> (stream local, p/ preview mudo). Rejeita com Error{code}
room.stopShare()         // para de compartilhar
room.leave()             // sai da sala e fecha tudo
room.self                // { id, name, sharing }
room.peers               // Map<id, { id, name, sharing, state }>
```

### Eventos (`room.on`)

| evento | payload | quando |
|---|---|---|
| `joined` | `{ self, peers: [{id,name,sharing}], max }` (`max` = limite da sala, 0 = sem limite) | entrou na sala |
| `peer-joined` | `{ id, name }` | alguém entrou |
| `peer-left` | `{ id, name }` | alguém saiu |
| `share-changed` | `{ id, sharing }` | alguém (inclusive eu) começou/parou de compartilhar |
| `stream` | `{ id, stream: MediaStream }` | chegou o vídeo da tela de `id` |
| `stream-ended` | `{ id }` | vídeo de `id` acabou |
| `connection` | `{ id, state }` | `state`: `connecting` \| `connected` \| `relay` (via TURN) \| `failed` |
| `reconnecting` | `{}` | caiu o WebSocket, tentando voltar |
| `reconnected` | `{}` | voltou |
| `error` | `{ code, message }` | ver códigos abaixo |

### Códigos de erro

- `room-full` — sala atingiu `MAX_PEERS` (fatal: não entrou; só existe se o limite estiver ligado)
- `name-invalid` — nome vazio / > 24 chars (fatal)
- `code-invalid` — código fora de `^[a-z0-9-]{3,24}$` (fatal)
- `share-denied` — usuário cancelou/negou o seletor de tela (não fatal, rejeição de `startShare`)
- `share-unsupported` — navegador sem getDisplayMedia (não fatal)
- `signaling-lost` — desistiu de reconectar (fatal)

Nome duplicado é permitido (o id distingue). Código é normalizado para minúsculas, sem espaços.

## Protocolo WebSocket (`wss://<host>/ws`) — JSON

cliente → servidor
- `{ t:"join", room, name }`
- `{ t:"signal", to, data }`   (data = { description } | { candidate })
- `{ t:"share", on:boolean }`
- `{ t:"ping" }`
- `{ t:"leave" }`   (saída explícita; sem ele o servidor segura o lugar por 35 s)

Campo opcional de `join`: `resume: { id, token }` — ao reconectar depois de uma queda, o cliente volta com o
mesmo id (o vídeo dos outros não cai). `token` vem do `welcome`.

servidor → cliente
- `{ t:"welcome", id, peers:[{id,name,sharing}], ice:[RTCIceServer...], token, resumed, boot, max }`
  (`ice` com credencial TURN efêmera; `resumed` = voltou com o mesmo id; `boot` muda quando o servidor reinicia)
- `{ t:"peer-joined", id, name }` / `{ t:"peer-left", id }`
- `{ t:"signal", from, data }`
- `{ t:"share", id, on }`
- `{ t:"error", code }`
- `{ t:"pong" }`

## Ações do usuário que a UI cobre

1. Digitar nome (lembrado em localStorage `telinha-name`)
2. Digitar código **ou** gerar código novo
3. Entrar (link `?sala=<code>` já preenche o código)
4. Copiar link/código da sala para convidar
5. Compartilhar tela / parar de compartilhar (com preview do que estou enviando)
6. Assistir: com 1 tela → ela grande; com várias → grade, clicar foca uma
7. Tela cheia em um vídeo
8. Ver quem está na sala (+ quem está compartilhando, estado de conexão)
9. Sair
10. Estados: sala vazia/ninguém compartilhando, sala cheia, navegador sem suporte (celular: só assiste),
    permissão negada, reconectando, conexão falhou
