## MODIFIED Requirements

### Requirement: 機密只送往它所屬的那個服務

機密 SHALL 只被送往它所屬服務的端點。端點的 scheme SHALL 限於 `https:`（白名單，非黑名單）。
**A WebSocket service's endpoint SHALL be limited to `wss:` in the same way**: the team server
(`team-membership`) is reached over a WebSocket, and its device secret is sent in that connection's `hello`.

**這是本能力四條出口中唯一真的會把憑證送出本機的那一條，而它是隨本次新增而出現的。**
一個可覆寫的端點加上一份憑證，就是「把憑證送到一個不是該服務的主機」的能力 ——
而驗收必然需要那個覆寫（真實服務要網路、要憑證、回應不可重現）。

端點為使用者可編輯的設定項（與服務的其餘連線設定同一份），因此它 SHALL 配上以下三者：

1. **只能由使用者明確操作改動** —— SHALL NOT 由投遞內容、routing 規則或任何其他外部輸入寫入。
2. **非預設值時 SHALL 對使用者可見** —— 他要能知道「我的憑證正在送往一個非官方的主機」。
   **一個沉默的端點欄位比沒有這個欄位更糟**：它把憑證的目的地變成一個沒有人會去看的值。
3. scheme 的白名單如上。

**The team server has no default endpoint**: its address comes only from the invite link the user pasted, and it
is written only by the user's join (`team-membership`). It SHALL therefore always be shown in the team's settings,
which satisfies the second rule for every value. No handoff, inbox delivery, agent outbox file or message from the
server SHALL change it.

**A relay grant (`phone-relay`) belongs to the phone it was made for.** Its secret is issued by the team server for
that phone to present, so it SHALL be sent only to that phone, inside the remote access listener's authenticated
connection of that phone (the `hello` answer and `relay.changed`), and never to another device, the renderer, a log
or any other destination. The device secret SHALL go to the team server in `relay.accept` on a relay leg, as in
`hello`, and only to the server of the stored membership. The address and pin given to the phone with a grant SHALL be
the membership's own, never a value from an event or another input.

#### Scenario: 端點非預設值時使用者看得到

- **WHEN** 端點被設為非預設值
- **THEN** 使用者於該功能的介面上看得到它不是預設值

#### Scenario: 外部輸入改不動端點

- **WHEN** 一則外部投遞的內容中含有端點欄位
- **THEN** 實際使用的端點未改變

#### Scenario: 非 https 的端點不被接受

- **WHEN** 端點被設為一個 scheme 不在白名單中的位址
- **THEN** 該值被拒絕，且機密不被送往該位址

#### Scenario: The team server's address is shown and written only by a join

- **WHEN** the device has joined a team, and an agent then writes an outbox file and a teammate's handoff arrives,
  both containing a field naming another server address
- **THEN** the Team section shows the address from the invite, and the device's `hello` still goes only to it

#### Scenario: A team server address that is not wss is refused

- **WHEN** the user pastes an invite whose server address is `ws://` or `https://`
- **THEN** the invite is refused and no connection is made

#### Scenario: A grant secret reaches only its phone

- **WHEN** two phones are connected, the relay setting is on, and each holds a grant
- **THEN** each phone's connection receives only its own grant's secret, and no frame to the other phone, no
  renderer state and no log line contains it

#### Scenario: The relay leg sends the device secret only to the membership's server

- **WHEN** a tunnel is accepted
- **THEN** `relay.accept` with the device secret is sent on a connection to the stored membership's server address,
  after its certificate was checked, and to no other host
