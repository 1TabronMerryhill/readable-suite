# The Desk — OpOne Capital Intelligence Desk

Spec v1. Written Nov 6, 2026, on Milly's word: "our firm needs the futuristic setup and interface, with the webhook from the real-time feed, charts, briefs and news. But this should be an intelligence desk. What would Axe do?"

Status: SPEC ONLY. Nothing here is built yet. The build starts on Milly's word.

## 1. The idea in one line

One screen that tells Milly the whole firm at a glance, and lets him touch any part of it to see why it is true.

Not a dashboard. A desk. A dashboard is a wall of gauges that all shout at once. A desk has one thing on it at a time, and the thing on it is the thing that matters most right now.

## 2. The two gates every feature must pass

**The Axe test.** Does this help eat what we kill? Does it make a kill faster, a win bigger, or a trap easier to see? If it does not change a decision, it does not ship. Axe Capital does not pay for decoration. Neither do we.

**The Jobs test.** Can Milly read the whole firm in one glance at 6 AM, half awake, on his phone? If the answer is no, cut it. Jobs cut the buttons, the menus, the clutter, until the work itself was the interface. The Desk does the same to trading. One glance. One decision. One tap.

A feature ships only when it passes both gates.

## 3. What it is, and what it is not

It IS:
- The firm's memory made visible. Every trade, every news event, every kill, in one living map.
- The place Milly opens first in the morning and last before the close.
- The surface where the knowledge graph stops being a file and starts being the firm.

It is NOT:
- A Bloomberg terminal. No 40 panels, no orange keyboard, no learning curve.
- A stock screener. Screening is Bobby's job. The Desk shows what Bobby found and why.
- A social feed. The Discord floor is the firm's voice, but the Desk is the firm's mind. The floor talks. The Desk decides.
- A chatbot. Bobby talks in chat. The Desk shows.

## 4. The 50-year view: what this becomes

Think ahead 50 years. The screens change. The firm does not.

In 2076, the interface is probably not a screen at all. It is voice, and glances, and surfaces we cannot name yet. But the firm still needs the same three things it needs today: what do we own, what is changing, and what do we do next. The Desk is built so the interface can change completely without rebuilding the firm. The graph is the firm. The Desk is a view onto the graph.

That is the design rule that matters most: **the interface is a view onto the knowledge graph, not a separate thing.** The graph holds the facts, the edges, the evidence, the outcomes. The Desk reads the graph and draws it. When the view changes in 10 years or 50, the firm keeps its memory, because the memory was never in the interface.

What compounds over 50 years is the graph. Every trade is a node. Every news event is a node. Every kill that saved money is a node. Every pattern that proved out is a node. In year one, the graph has 118 nodes. In year ten, it has the firm's whole history. In year fifty, it is the reason the firm still wins: no other firm remembers this well, and memory is the edge that never decays.

The Desk in 50 years is the firm's memory with a face. Today we build the first face.

## 5. The Desk itself: one screen, three depths

One screen. Three depths. Milly never navigates. He goes deeper into the same screen.

### Depth 1: The Glance

The whole firm in one line, at the top, always:

- Real book: value, cash, open P&L, today P&L.
- Paper book: value, today P&L. Kept separate, never mixed.
- The one thing that needs Milly: the single most urgent item, in plain words. "MU is $14 from its stop." Or "DUOL reclaimed $161.27." Or "Nothing needs you." If nothing needs him, the Desk says so. Silence is a feature.

Below the line: the open positions as three (later five) cards. Each card is one line: ticker, price, P&L, distance to stop, distance to target. Green is money made. Red is money at risk. Nothing else is colored. Color is reserved for money and for kills.

### Depth 2: The Position

Tap a card. The Desk opens that position, full screen. This is where the charts live.

**The chart.** One chart per position. Price line, volume bars, and four horizontal lines: entry, stop, target, kill. The chart answers one question: where are we relative to the plan? That is all a chart has to do.

- News markers on the tape. Every news event that touches this asset is pinned to the chart at the moment it hit, as a small diamond. Tap it: the headline, the fundamental read, and the second-order effects. This is the graph alive on the tape. The chart is no longer just price. It is price with its reasons attached.
- The package, beside the chart. Thesis in two sentences. The business check in Milly's order: management, employees, cash to R and D, shareholder returns. True worth and margin of safety. The kill criterion, in plain words. The exit plan.
- The fill record. Order id, fill price, fees, time. From the record itself, never from memory.

What the chart does NOT show: RSI panels, MACD panels, Bollinger bands, or any indicator that needs a legend. If Bobby needs an indicator to make the case, the case goes in the package as words. The chart stays clean.

### Depth 3: The Graph

Tap the map. The Desk opens the living knowledge graph.

- Nodes: news events, assets, themes, companies, trades, outcomes, regimes. Node size follows relevance to the live book. A theme with no live position is small. A theme holding two live positions is large.
- Edges: labeled, with evidence. "MU follows ai_capex." "Payrolls hot precedes semis down." Every edge carries its timestamp and its source. Tap an edge, see the evidence.
- News nodes pulse when fresh. A node that moved in the last hour glows. A node that went quiet fades. The graph breathes with the tape.
- Trade nodes show live P&L. A trade node is green when the position is winning, red when it is losing, grey when it is a signal that never triggered.
- Connector candidates are dotted edges, waiting. The graph proposes: "DUOL recurs. Promote to connector?" Milly taps yes or no. The graph never promotes itself. That is the human gate, drawn on the map.
- Patterns are a separate shelf, not nodes. A pattern is a derived aggregate with n, win rate, average R, and status (candidate, live, retired). It never pretends to be a fact. It sits on the shelf until n reaches 10 and the record earns it.

The graph is the firm's memory, and the Desk is where Milly reads it. This is the part that makes the Desk different from every trading screen that has ever shipped: every other screen shows price. This one shows why.

## 6. The feeds: briefs and news

**The Brief.** The 6 AM morning meeting lives on the Desk, top of the feed, every day. Overall brief first, then the five trade briefs. Each brief is linked to its graph nodes: tap a trade brief, see its trade node, its news events, its theme. The brief is not a document. It is the graph, written out.

**The Wire.** News arrives as a stream, newest first. But the Wire is not a headline firehose. Every item carries three things:

1. The fundamental read: what it means for earnings, supply, demand, rates, policy.
2. The affected-sector map, including second-order effects.
3. The verdict: does this change a live slot? "No change to MU." Or "Watch: this hits the Taiwan plant thesis." Or "Kill watch: gold below $4,000 on a close."

Items are ranked by the verdict, not by time. An item that touches a live position outranks an item that does not. The Wire is the Discord team's pull, the morning research, and the vendor news, all flowing through the same ranking: what matters to the book we actually hold.

## 6b. The Newsroom: the membership layer (Milly's word, Nov 6, 2026)

Milly's words, Nov 6, 2026: "This needs an editorial newsroom, so I can engage interactively. There should also be charts and candlesticks and technical analysis and fundamental analysis, and research insights. I need insights, so I can learn." And at 19:45 CT the same day: the Newsroom is the layer people could pay for, because it shows how the fund looks at markets, business, and investment capital.

That makes the Newsroom the membership layer. It is the product. The three lenses are the product:

1. **The market read.** Charts and candlesticks, with technical analysis computed from the same candles: trend, SMA 20 vs SMA 50, RSI 14 as a number with a plain reading, support and resistance from recent swing highs and lows, a volume note, and one paragraph stating what would change the read. This revises the earlier rule in Depth 2 that the chart shows no indicators. Milly's direction adds technical analysis to the Desk. The revised rule: indicators are numbers with plain readings, never unexplained panels. RSI is a number plus overbought, oversold, or neutral. SMAs are toggleable lines on the chart. No indicator ships without its plain reading attached.
2. **The business check.** The fundamental panel, in Milly's order: management, employees, cash to R and D, shareholder returns. Thesis, kill criterion, stop and targets, intrinsic worth vs price with the margin of safety where recorded, and the crash screen with the minus 10 percent and minus 20 percent DCA markers. Where the record has no business check or worth, the panel says so plainly. A bounce-only verdict stays bounce-only.
3. **The capital read.** What the fund does with capital: size committed, max loss, profit and R to each target, and the concentration read across the book. The Nov 6 record carries it: slots 1, 2, and 3 are one trade, the chip bounce, $63.24 of the $105.44 paper book on a single theme. Capital is the third lens, and it is what turns a read into a position.

**The seam.** The Newsroom shows the lens, not the firm's book. The firm's live book, fills, quantities, order ids, and P and L stay in the Glance and Positions sections, which are the firm's own view. The Newsroom carries the plan levels (entry, stop, targets, kill) because the plan is the lens. It never carries a quantity held, a P and L, an order id, or a book total. That separation is the seam a membership build needs: a member sees how the fund thinks, not what the firm holds. The Phase 5 rule already in this spec governs the seam: the firm's book and a member's book are separate views, and one member's data never appears in another member's view.

**No price, no gate, no charge now.** No price is set for the Newsroom. Nothing is gated and nothing is charged. The build now is the seam, not the paywall. When membership is built, the gate goes on the seam that already exists. It does not get invented then.

**Design.** The Newsroom sits on the Desk page in the same design language: one screen, three depths, color reserved for money and kills. It is interactive, and that is the point: a symbol picker (live positions first, then conditionals, then the watchlist), timeframe buttons (1mo, 3mo, 6mo, 1y), an SMA toggle, a canvas candlestick chart where tapping a candle reads its open, high, low, close, and volume, a technical panel and a fundamental panel side by side, and a dated research feed below. Clicking a symbol loads it in the Ask panel context, so the Newsroom and the Ask panel read the same symbol together.

**Drawing layer (Milly's word, Nov 7, 2026, 00:13 CT).** "I need to be able to draw on the charts like the most premium package of TradeView. I need the advanced package." The chart carries a drawing toolbar: Select, Trend line, Horizontal line, Horizontal ray, Vertical line, Rectangle, Fibonacci retracement, Text note, Freehand brush, Eraser, Undo, Clear all (with confirmation). It works with mouse and touch; touch is first class, because Milly is on his phone: while a draw tool is active the canvas takes the finger instead of scrolling the page, and while Select is active a tap still reads the candle. A drawing anchors to price and candle time, so it survives timeframe switches, SMA toggles, and resizes. Plan levels stay visible under the drawings and are not editable drawings. Fibonacci draws two taps for the range and levels 0, 23.6, 38.2, 50, 61.8, 78.6, and 100, each with a price label. Drawings are the member's own analysis on top of the firm's levels, not a vendor indicator. That extends the revised Depth 2 rule: indicators are numbers with plain readings, and member markup is the member's own read, drawn on the chart, never presented as the firm's call. Drawings save to localStorage per symbol, on this device only. The page says so plainly. There is no server store yet, so a drawing does not follow Milly to another device. When a server store lands, the same anchor shape (candle time plus price) carries over.

**Data rules.** Candles come only from the Yahoo v8 chart endpoint, through the `/api/chart` Netlify function, which also computes SMA 20, SMA 50, and RSI 14 server side. No candle is ever drawn from a fill price or a stale price. On a data failure the function returns 502 and the page shows a plain "chart unavailable" and keeps the last good chart labeled with its as-of time. Technicals are computed from those candles and labeled with their source. Fundamentals come only from the recorded Nov 6 packages and graph facts. Nothing is invented: no fundamental, no price, no verdict the packages do not support. Every entry in the research feed carries its as-of date. Nothing dated Nov 6 is presented as today's news. Open connector candidates appear as open questions, never as conclusions.

**What keeps it fresh.** The Newsroom is only as fresh as its last package. It needs a daily feed from the morning brief: new insights, new packages, updated worth, and a rebuild cadence that carries the new day's facts into the panels. Until that feed exists, the Newsroom is a Nov 6 record, and it says so on the page.

**Teaching rule (Milly's word, Nov 7, 2026, 00:53 CT).** "Truthfully I need for this to be a tool that teaches me as well. So, when I use the tool, it should also not only tell me what it means, but also what it means for the asset in question." The Desk teaches. Every reading in the Newsroom carries two parts, side by side, in plain short sentences: what this means (the definition, no jargon) and what it means for the asset in question (the implication, computed from that asset's own numbers: price, stop, targets, support and resistance, worth vs price, verdict). This applies to every TA item (trend, SMA 20 vs SMA 50, RSI 14, support, resistance, volume, Fibonacci levels, each candle pattern the chart names) and every FA item (thesis, margin of safety, business-check items, crash screen, DCA markers, capital read). The asset-specific part is computed from the selected symbol's real data, never a generic sentence with the ticker swapped in. Where the record has no basis for an implication, the panel says "The record does not say yet" instead of inventing one. Every term in the TA and FA panels is tappable and opens a short two-part explainer for the current symbol, one open at a time. Tapping a candle shows its OHLC plus one plain sentence stating what that candle means for the asset, from that candle's own numbers and the levels on the chart, or a plain statement that nothing notable follows. Every panel ends with a lesson line in the same voice as the research insights. A generic definition without the asset-specific implication does not ship.

**Practice rule (Milly's word, Nov 7, 2026, 00:55 CT).** Random practice lessons on the tools, so he has to use the tool to reach a stated end result and becomes a master at technical analysis. The Desk teaches by making him use the tools to reach a stated end result, at random, until the analysis is a skill, not a read. A "Give me a lesson" button picks a drill at random from a deck built from the selected symbol's real chart data: draw a trend line connecting the two swing lows, mark the support level, mark the resistance, draw the Fibonacci retracement from the recent high to the recent low, draw a rectangle around the consolidation, place a text note naming what the last candle did. The drill's target is computed from the same candles and TA the page already has, and no drill exists whose answer the data cannot support. When he draws, the page checks his drawing against the drill's target with a stated tolerance and tells him plainly whether he got it, what was right, and what was off, in the asset's own numbers. A correct drill records the lesson learned in one sentence and marks the drill done. A wrong attempt explains the miss and lets him try again. No score grades his trading, only whether the tool work matched the chart. Completed drills save to localStorage per device, and the page shows how many drills he has completed and which tools he has practiced. A "New lesson" button draws another at random, never the same drill twice in a row. Every drill carries what the tool means and what the result means for the asset, under the same teaching rule. The drills live on their own Practice tab; the chart stays in the Newsroom, and a drill banner over the chart carries the drill's goal while he draws.

**Tab loop (Milly's word, Nov 7, 2026, 01:02 CT).** The Desk has a lot on one page, so one screen is reached through tabs. A horizontal tab bar, sticky under the header, holds one tab per section: Glance, Positions, Newsroom, Practice, Wire, Graph, Ask. Only the active tab's section shows. Switching tabs is instant, with no page reload. The URL hash reflects the active tab (#tab=glance and the like), so a tab is deep-linkable and the back button works. On a phone the bar scrolls horizontally and stays thumb-reachable. The tabs form a daily feedback loop, in this order: Glance (what needs you) to Newsroom (learn the read) to Practice (drill it) to Positions (see the plan) to Graph (see why) to Ask (ask the graph) and back to Glance. Each tab ends with a plain Next line that names the next tab in the loop and why it follows. Each tab carries one short line naming the skill it trains: Glance trains the eye for what matters, Newsroom trains the read, Practice trains the hand, Positions trains the plan, Graph trains the memory, Ask trains the question. A loop progress line under the tab bar shows where he is in the loop ("Step 2 of 6: Newsroom, learn the read") and that the loop repeats daily. Wire is intake, not a step: it holds the Wire and the Brief, and it feeds the loop. The loop is the training workflow for building and facing the Operator One venture: the Desk trains him to build the firm and be its face, one loop a day.

## 7. Real time: the event bus and the webhook contract

This is the part Milly asked for by name: the webhook from the real-time feed. Here is the honest architecture.

**Finnhub has the webhook, two ways.** One: the trades websocket at `wss://ws.finnhub.io?token=KEY`, where we connect and subscribe. Two: the dashboard outbound webhook, where Finnhub's server POSTs events to a URL Milly configures, with an `X-Finnhub-Secret` header for authentication. **The receiver lives on the Desk's own subdomain, not on Readable: `opone.tabronmerryhill.com/api/finnhub-webhook`.** The receiver is built as a Netlify function (`desk-build/netlify/functions/finnhub-webhook.js`, staged; the earlier staging spot in `readable-suite/netlify/functions/` is the old location and the function moves with the Desk site). It verifies the secret against the `FINNHUB_WEBHOOK_SECRET` env var, returns 200 before doing any logic, and logs the event. The secret lives only in the Netlify dashboard, never in a file or in chat. The function is staged for the next deploy batch; it is not live until the batch ships. The exact Finnhub event catalog was not verifiable from public docs; the receiver is payload-agnostic, and the Test Webhook button reveals the shape live. Subscribe format for the websocket: `{"type":"subscribe","symbol":"MU"}`, trades arrive as `{"type":"trade","data":[{"s":"MU","p":691.73,"v":10,"t":...}]}`. Free tier: one connection per key, up to 50 symbols, US stocks plus forex and crypto. The dedicated news websocket is a Premium feature, so news stays on REST. Robinhood MCP is request/response: we ask, it answers. Discord is a poll. So the webhooks are Finnhub's trades stream and Finnhub's outbound POSTs, and the poller bridge covers everything else until its own webhook exists. One honest blocker: our Finnhub key returns 401 (retested Nov 6, 13:37 CT). The websocket uses the same key, so it cannot connect until Milly re-enters the exact key from the Finnhub dashboard. The websocket client is built and ready: `~/workspace/custom-connectors/custom.finnhub/bin/finnhub_ws.py`. It emits the bus event `quote.tick` per trade.

One flag, plainly: Finnhub's self-serve plans are licensed for personal use. Business use needs an Enterprise contract. OpOne Capital is a business. That is Milly's call: proceed on the free key, pay for a plan, or use another vendor. The Desk does not care which vendor feeds it. The bus does not care either.

The fix is an event bus with a fixed contract. Pollers are producers. Webhooks are producers. The Desk is a subscriber. It never knows or cares which one produced an event. When a real webhook arrives later, it plugs into the bus without touching the Desk.

**The contract.** Every event is one JSON object:

- `type`: one of the event types below.
- `id`: unique per event.
- `ts`: UTC timestamp of the event.
- `source`: robinhood_mcp, finnhub, discord, watch, graph, brief.
- `feed`: the data quality flag, same as the graph uses (robinhood_mcp, yahoo_snapshot, finnhub, discord).
- `payload`: the event data.
- `graph_refs`: the graph node ids this event touches, so the Desk can light up the right nodes the moment the event lands.

**Event types:**

- `quote.tick`: a price for a watched symbol.
- `quote.level`: a price crossed a level that matters (near stop, near target, near kill). Carries distance to the level.
- `news.event`: a news item, with its theme edges and its slot verdict.
- `trade.signal`: Bobby's packaged signal, with thesis, kill, size.
- `trade.placed`: an order placed, with order id and terms.
- `trade.filled`: a fill, with price, quantity, fees, time. From the broker, never assumed.
- `trade.trimmed`: a trim, with the reason.
- `trade.stopped`: a stop hit, with the loss and the lesson.
- `alert.trigger`: a watch level hit (trigger, target, stop, kill, stood down).
- `brief.published`: the morning brief posted, with its message ids.
- `graph.pattern`: a pattern changed status (candidate, live, retired).
- `graph.connector`: a connector candidate flagged or confirmed.

**The poller bridge (Phase 2).** A small service that polls Robinhood MCP quotes, runs the 5-minute watch, reads the Discord floor, and emits the same events onto the bus. The Desk subscribes over SSE. The bridge is the only part that knows about polling. Everything downstream is event-driven.

**What is real today.** Robinhood MCP live quotes and orders work. The graph is file-first, 118 nodes, rebuilt deterministically. Discord is the open book. The watch runs every 5 minutes on Yahoo snapshots. Finnhub is 401 until Milly re-enters the key. The webhook is Finnhub's websocket; the client is built and ready. The bus is the plan that makes the webhook possible without rebuilding the Desk.

## 7a. The subdomain first, then the wire (Milly's word, Nov 6, 2026)

**Milly's word, Nov 6, 2026: the subdomain is `opone.tabronmerryhill.com`.** Build everything first, then wire it: the subdomain, the webhook URL, the secret, last. The wiring is Namecheap DNS (CNAME host `opone` to the Desk Netlify site) plus the subdomain added as a custom domain on that site, the same pattern as `daymarket.tabronmerryhill.com` and `openline.tabronmerryhill.com`. Milly signs in to Namecheap himself; the browser adds the record. The Finnhub dashboard URL field takes `opone.tabronmerryhill.com/api/finnhub-webhook` once the domain is live, and the Netlify site needs `FINNHUB_WEBHOOK_SECRET` and `GROQ_API_KEY` set in its environment. He also confirmed Nov 6 he paid the overdue merryhill-workshop team payment.

## 7b. Talking to the graph: the graph is the memory and the brain, Groq is the voice (Milly's word, Nov 6, 2026)

The Desk talks. Milly asks the graph a question in plain words, and the graph answers from its own memory. The graph is the memory and the brain. The LLM is the voice that speaks for it. Groq is the voice for now, and the model is replaceable by design: one constant, one env var, per the separation of intelligence and logic. Groq is already wired in this house: the DayMarket station functions and `ai-chat.js` call `api.groq.com/openai/v1/chat/completions` with model `openai/gpt-oss-120b` and the key from `GROQ_API_KEY`, and the VictoryLap coach chat runs on the same backend. The Desk follows the same pattern.

The shape, staged in `desk-build/netlify/functions/graph-chat.js`:

- The Desk retrieves the relevant graph context first: nodes and edges with ids, labels, and evidence. Retrieval is deterministic and local.
- The function sends the question plus that context to Groq with a system prompt that says: answer only from the context, cite every claim with its node or edge id, and say plainly when the graph does not record it. Never invent a price, a fill, or a balance. Never recommend a trade without its kill criterion. Never place a trade. A signal scorecard is not a trade. A pattern is not an edge.
- The key lives server-side in `GROQ_API_KEY`, never in the browser. The function returns the answer, the model name, and the ids actually cited.
- In Phase 1 the chat panel answers by local retrieval over the embedded graph snapshot and labels itself as such. The Groq voice plugs in when the Desk site deploys, without changing the layout. The panel never pretends to be Groq before the wire is live.

The graph proposes, the voice speaks, Milly decides. Talking to the graph never becomes trading by the graph.

## 7c. The stack (Milly's direction, Nov 6, 2026)

JSON, Java, C++, and Python. Each has one real job, no token usage:

- JSON is the data contract: the graph, the ledger, the event bus events, the Desk's data file.
- Python runs the graph builder, the watch, and the feed transport (the Finnhub websocket client, the Robinhood reads).
- Java runs the event bus: validates events against the contract, keeps the log, serves the Desk over SSE.
- C++ runs the tick normalizer: reads Finnhub trade lines, parses them at line rate, emits `quote.tick` events.

The services are scaffolded in `~/workspace/bobby-axelrod/desk-services/`. The Desk surface reads the bus; it never knows which language produced an event.

## 8. Design language

**Color.** Ink black background. Cream text. Orange is the firm's accent, used for the firm's name and for the one action on screen. Green and red are reserved for money and for kills, and for nothing else. If everything is colored, nothing is urgent.

**Type.** A serif for the firm's voice: the brief, the thesis, the verdict. A mono face with tabular numerals for every price and P&L, so numbers align and the eye can scan a column of prices without effort. Prices are never in a proportional font.

**Motion.** Only the tape moves. Only fresh news pulses. Nothing decorative animates. A screen that moves for no reason is a screen that lies about urgency.

**Sound.** Almost none. Two sounds exist. A soft tick on a fill. A low tone on a kill. The kill tone is the most important sound in the firm: it means a rule worked and money was saved. Everything else is silent.

**The firm's mark.** The Desk carries the OpOne Capital name and the Workflow serif W where the firm speaks. The Desk is the firm's instrument, and it should look like it belongs to the firm, not to a vendor.

## 9. The portfolio view: this is a firm, truly

The Desk has a second mode, and it matters: the firm is not one trade. It is a portfolio.

- The Book view is the portfolio: every open position, every closed position, cash, the paper book beside the real book, whole-book totals, never winners only.
- Each position is a company, not a ticker. The position view carries the business check: management, employees, cash to R and D, shareholder returns. The firm owns pieces of businesses. The tape is just the price of those pieces today.
- Over time, the Desk grows a holdings view: the companies the firm has owned, the ones it killed, the ones it will never touch again and why. The graph remembers the why. That is the portfolio's memory, and it is the edge.

This is the difference between a trading app and a firm. An app shows positions. A firm remembers why it owns them.

## 10. Data model: what the Desk reads

The Desk reads the firm's own files. Nothing is re-entered. Nothing is typed twice.

- `~/workspace/bobby-axelrod/BRIEF.md`: the operating terms, the mandate, the risk rules.
- `~/workspace/bobby-axelrod/ledger.json`: the paper book and the real executions.
- `~/workspace/bobby-axelrod/real-orders-2026-11-06.json`: order and fill records.
- `~/workspace/bobby-axelrod/knowledge-graph/graph.json`: the living map, rebuilt deterministically from `facts/`.
- `~/workspace/bobby-axelrod/today-slots.json` and `watch-state.json`: the live slots and their levels.
- Discord #opone-capital: the open book and the floor's voice.
- Robinhood MCP: live quotes, portfolio, orders.
- Finnhub: news and quotes, once the key is fixed.

If a number on the Desk cannot be traced to one of these, it does not belong on the Desk.

## 11. Build phases

**Phase 0: now.** The spec. The data already exists: the graph, the ledger, the fills, the briefs, the Discord floor. Nothing new is collected. The spec is the plan.

**Phase 1: The Desk v1, static.** A web surface that reads the firm's files and draws them: the Glance line, the position cards, one chart per position with levels and news markers (price history from Yahoo, levels from the packages), the brief, the Wire from Discord, and the graph as a readable map. No live feed. It updates when Bobby rebuilds it. This proves the design before any plumbing exists. **Building Nov 6, 2026: the v1 surface plus the Ask the graph panel, which answers by local retrieval over the embedded graph snapshot and labels itself as such. The Groq voice and the Finnhub webhook receiver are staged as Netlify functions in `desk-build/netlify/functions/` and ship with the Desk site.**

**Phase 2: Live.** The poller bridge and SSE. Quotes from Robinhood MCP. Watch alerts as events. Fills as events. The Desk updates itself. The 5-minute watch stays as the heartbeat until the bridge replaces it.

**Phase 3: Webhooks and the Wire.** Finnhub key fixed, or a news vendor that actually webhooks. News events flow into the graph in real time and onto the Wire with their slot verdicts. The Discord team's pulls flow in the same way. The graph starts growing during the day, not just at rebuild time.

**Phase 4: The Desk as the firm's OS.** Voice: "Bobby, what is the book?" and the Desk answers from the graph. Pattern alerts from the graph, not just price alerts. The holdings view across the whole portfolio. The 50-year memory, accumulating. The interface can change. The firm does not have to.

**Phase 5: Membership, later.** (Milly's direction, Nov 6, 2026.) People pay for access to the firm's intelligence and to use the agents for their own portfolios. The Desk is built for this from the start: the firm's book and a member's book are separate views, and one member's data never appears in another member's view. No price is set. Nothing is built for membership until Milly says so. Phase 1 through 4 serve the firm first.

## 12. Non-goals

- No screener. No watchlist of 500 names. The Desk shows what the firm holds and what Bobby is packaging. The universe is Bobby's problem, not the Desk's.
- No social. No likes, no comments, no feed of other people's opinions. The floor talks in Discord. The Desk decides.
- No settings screen. The Desk has opinions. Milly overrules by telling Bobby, not by toggling 40 switches.
- No paper-only mode that hides the real book. The real book is the firm. The paper book is the scoring model. Both are visible, always, separate, always.
- No certainty. No "will go up" anywhere. Analysis plus probabilities, always, even on the prettiest screen.

## 13. Open questions for Milly

1. Phone first or desk first? The Desk is drawn for the phone in this spec, because that is where Milly lives. Say if the big screen is the home instead.
2. Where does it live? A web space Milly opens, or a local app on his machine? A web space is the fastest first build.
3. The name. "The Desk" is the working name. It can stay, or take a better one.
4. Sound on or off by default? The spec says two sounds exist. The default is Milly's call.
5. Does the Desk show the paper book on the Glance line, or only the real book, with paper one tap down? The spec shows both, separate. Milly's call.
6. The Discord channel topic still says "Milly executes." It needs a browser edit to match the new model. Fix it as part of Phase 1, or leave the topic as history?
7. The subdomain name. Milly's word Nov 6, 2026: `opone.tabronmerryhill.com`. Wiring in progress.

## 14. The Axe answer

What would Axe do? Axe would not build a prettier Bloomberg. Axe would build the one screen that tells him, before anyone else in the room, what to kill and what to press. He would put the firm's memory on the wall, because the firm that remembers wins. And he would make the interface disappear, because the trade is the work and everything else is noise.

That is the spec. The Desk is the firm's memory with a face, the graph alive, the tape with its reasons attached, and one glance that tells Milly what needs him.

Build it on his word.
