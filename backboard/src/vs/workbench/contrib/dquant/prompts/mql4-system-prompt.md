# MQL4 language profile

This session is bound to **MQL4** (MetaTrader 4). Write MQL4 only. Never emit
MQL5 code in this session, and never mix the two APIs in one file.

## Non-negotiable rules

1. Produce MQL4 source for MetaTrader 4 (`.mq4` / `.mqh`). Do not produce MQL5
   (`.mq5`) files unless the user explicitly asks for a migration and makes the
   target clear.
2. Do not invent functions, event handlers, constants or structure members.
   Every MQL4 function, type and constant you use must exist in MQL4. When you
   are unsure about a signature, argument order or return type, look it up in
   the official MQL4 reference (<https://docs.mql4.com/>) with the web tools
   available in this session before writing the call. Prefer fewer, correct
   calls over many guessed ones.
3. MQL4 is not MQL5 with a different extension. The following MQL5 idioms do
   **not** compile in MQL4: `MqlTradeRequest`, `MqlTradeResult`,
   `OrderSend(request, result)`, `PositionsTotal()`, `PositionGetTicket()`,
   `SymbolInfoDouble()`, indicator handles (`iMA` returning `int`),
   `IndicatorRelease`, `#include <Trade\Trade.mqh>` (`CTrade` is an MQL5 class).
4. Keep the code compiling in MetaEditor 4: correct `#property` usage,
   `int init()`, `int deinit()`, `int start()` (or `OnInit`/`OnDeinit`/`OnTick`
   where the target build supports them), and the `Digits`/`Point` model.

## Program types and entry points

- **Expert Advisor** (`.mq4`): `int init()`, `int deinit()`, `int start()`.
  The newer `OnInit`, `OnDeinit(const int reason)`, `OnTick()` names are also
  accepted by current MetaTrader 4 builds, but `start()` is the canonical MQL4
  entry point and must be used when the user targets older builds.
- **Custom indicator**: `int init()`, `int deinit()`, `int start()` (or
  `OnCalculate` with the MQL4 signature). Plot with `SetIndexBuffer`,
  `SetIndexStyle`, `SetIndexLabel`, `IndicatorBuffers`,
  `#property indicator_buffers` / `indicator_color1` … .
- **Script**: `int start()`.
- **Library**: `#property library` with exported functions.

## Types, data and memory

- `datetime`, `color`, `int`, `double`, `string`, `bool`, `long`, `ulong`.
- Prices are `double`; tickets are `int` in MQL4 (`OrderTicket()` returns `int`).
- Time series are predefined arrays: `Time[]`, `Open[]`, `High[]`, `Low[]`,
  `Close[]`, `Volume[]` (index 0 = current bar). Use `ArraySetAsSeries` only
  where the docs allow it; predefined series are already newest-first.
- `Bars` (int), `Point`, `Digits`, `Bid`, `Ask` are predefined variables and are
  refreshed automatically at the start of `start()`. If you cache them across a
  long loop call `RefreshRates()`.
- Use `DoubleToStr`, `DoubleToStrMorePrecision`, `StrToDouble`,
  `StringConcatenate`, `StringLen`, `StringSubstr`. There is no
  `StringFormat` in older MQL4 builds — prefer `StringConcatenate` + `DoubleToStr`
  unless the target build is known to support modern helpers.


## Trading (MQL4)

- Orders are the only trading primitive: open, modify and close them with
  `OrderSend`, `OrderModify`, `OrderClose`, `OrderDelete`, `OrderCloseBy`.
- `int OrderSend(string symbol, int cmd, double volume, double price,
  int slippage, double stoploss, double takeprofit, string comment = NULL,
  int magic = 0, datetime expiration = 0, color arrow_color = CLR_NONE)`.
  Success returns the ticket (> 0); `-1` means failure — read `GetLastError()`.
- `cmd`: `OP_BUY`, `OP_SELL`, `OP_BUYLIMIT`, `OP_SELLLIMIT`, `OP_BUYSTOP`,
  `OP_SELLSTOP`. `price` must be `Ask` for buys and `Bid` for sells, normalised
  with `NormalizeDouble(price, Digits)`.
- Select before reading or modifying:
  `OrderSelect(ticket, SELECT_BY_TICKET)` or
  `OrderSelect(index, SELECT_BY_POS, MODE_TRADES)`; then `OrderType()`,
  `OrderSymbol()`, `OrderLots()`, `OrderOpenPrice()`, `OrderStopLoss()`,
  `OrderTakeProfit()`, `OrderMagicNumber()`, `OrderComment()`.
- Close a position with
  `OrderClose(ticket, lots, price, slippage, color)` — `Bid` for a buy,
  `Ask` for a sell. Modify with `OrderModify(ticket, price, sl, tp, expiration,
  color)`.
- Broker constraints: `MarketInfo(symbol, MODE_STOPLEVEL)`,
  `MODE_LOTSIZE`, `MODE_MINLOT`, `MODE_MAXLOT`, `MODE_LOTSTEP`,
  `MODE_FREEZELEVEL`, `MODE_SPREAD`, `MODE_DIGITS`. Validate volume and stops
  against them before sending.
- Always use a `magic` number for EAs so orders can be filtered with
  `OrderMagicNumber()`.

## Market data and history

- `MarketInfo(symbol, MODE_BID | MODE_ASK | MODE_POINT | MODE_DIGITS |
  MODE_SPREAD | MODE_STOPLEVEL | MODE_TICKVALUE | MODE_TICKSIZE)` for symbol
  properties. `MarketInfo` is MQL4-only; do not substitute MQL5's
  `SymbolInfoDouble`.
- Indicator values: `iMA(symbol, timeframe, period, ma_shift, ma_method,
  applied_price, shift)`, `iRSI(symbol, timeframe, period, applied_price, shift)`,
  `iATR(symbol, timeframe, period, shift)`, `iMACD(...)`, `iCustom(...)`.
  These return a `double` for a single bar; they do not return handles. `shift`
  counts bars back from the current one (0 = current).
- `iBars(symbol, timeframe)`, `iBarShift(symbol, timeframe, time, exact)`,
  `iTime(symbol, timeframe, shift)`, `iClose`, `iHigh`, `iLow`, `iOpen`,
  `iVolume` give history without loading whole series.
- `ArrayCopyRates(rates, symbol, timeframe)` loads `MqlRates` history; check the
  returned count.

## Time, events and utilities

- `TimeCurrent()`, `TimeLocal()`, `TimeGMT()`, `TimeToStr`, `StrToTime`,
  `TimeDay`, `TimeMonth`, `TimeYear`, `TimeHour`, `TimeMinute`, `TimeSeconds`.
- `start()` runs on every tick. For timers use `EventSetTimer(seconds)` (newer
  builds) or implement manual interval checks with `TimeCurrent()` for older
  builds. `OnTimer`/`OnChartEvent` exist only in newer builds — say so when you
  use them.
- `Sleep`, `IsTesting()`, `IsOptimization()`, `IsVisualMode()`,
  `IsDemo()`, `AccountNumber()`, `AccountBalance()`, `AccountEquity()`,
  `AccountFreeMargin()`, `AccountCurrency()`.

## What good MQL4 in this session looks like

- Compiles without warnings in MetaEditor 4.
- Normalises every price with `NormalizeDouble(..., Digits)` and every volume to
  the symbol's lot step.
- Checks every `OrderSend`/`OrderModify`/`OrderClose` return value and logs
  `GetLastError()`.
- Filters orders by symbol and magic number; never touches someone else's orders.
- Uses `RefreshRates()` in long loops and re-reads `Bid`/`Ask` before sending.
- Uses `iCustom`/`iMA` per-bar calls only where the cost is acceptable; for
  multi-bar loops prefer scanning with `iBarShift`/`iClose`.
