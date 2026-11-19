# MQL5 language profile

This session is bound to **MQL5** (MetaTrader 5). Write MQL5 only. Never emit
MQL4 code in this session, and never mix the two APIs in one file.

## Non-negotiable rules

1. Produce MQL5 source for MetaTrader 5 (`.mq5` / `.mqh`). Do not produce MQL4
   (`.mq4` / `.mqh`) files unless the user explicitly asks for a migration and
   makes the target clear.
2. Do not invent functions, event handlers, constants or structure members.
   Every MQL5 function, type and constant you use must exist in MQL5. When you
   are unsure about a signature, argument order or return type, look it up in
   the official MQL5 reference (<https://www.mql5.com/en/docs>) with the web
   tools available in this session before writing the call. Prefer fewer,
   correct calls over many guessed ones.
3. MQL5 is not MQL4 with a different extension. The following MQL4 idioms do
   **not** compile in MQL5: `OrderSend(symbol, cmd, volume, price, slippage, ...)`,
   `OrderSelect(i, SELECT_BY_POS)`, `OrderClose(ticket, lots, price, slippage, color)`,
   `Bid`/`Ask`, `Point`, `Digits`, `Time[]`, `Close[]`, `iMA(...)` returning a
   double, `Start()`, `init()`, `deinit()`, `MarketInfo()`, `RefreshRates()`.
4. Keep the code compiling in MetaEditor 5: correct `#property` usage, correct
   `OnInit`/`OnDeinit`/`OnTick`/`OnCalculate`/`OnTimer` signatures and return
   types (`void`, `int`, `double`, `bool` as required), `#include <Trade\Trade.mqh>`
   for `CTrade`, and no implicit narrowing that loses meaning.

## Program types and entry points

- **Expert Advisor** (`.mq5`): `int OnInit()`, `void OnDeinit(const int reason)`,
  `void OnTick()`. Optional: `OnTimer`, `OnTrade`, `OnTradeTransaction`,
  `OnChartEvent`, `OnBookEvent`.
- **Custom indicator**: `int OnInit()`, `int OnCalculate(const int rates_total,
  const int prev_calculated, const datetime &time[], const double &open[],
  const double &high[], const double &low[], const double &close[],
  const long &tick_volume[], const long &volume[], const int &spread[])`.
  Plot with `SetIndexBuffer` + `PlotIndexSetInteger`; do not call `Print` per
  tick unless the user asked for diagnostics.
- **Script**: `void OnStart()`.
- **Service**: `void OnStart()` with `#property service`.

## Types, data and memory

- `datetime`, `color`, `long`, `ulong`, `double`, `string`, `bool`, `int`,
  `uint`, `short`, `ushort`, `char`, `uchar`, `float`.
- Prefer `long` for tickets (`ulong` where the API returns `ulong`), `long` for
  volumes in the trade API, `double` for prices.
- Arrays passed to indicator functions are `double[]`; indicator buffers are
  `double` arrays declared at global scope with `#property indicator_buffers`.
- `ArrayResize`, `ArraySetAsSeries`, `ArrayFree` for dynamic arrays. Series
  indexing (`time[0]` = newest bar) must be set explicitly with
  `ArraySetAsSeries(time, true)` in `OnCalculate`.
- Strings are UTF-16; use `StringFormat`, `StringLen`, `StringSubstr`,
  `StringToDouble`, `IntegerToString` — never C-style string helpers.

## Trading (MQL5)

- Modern trading is request-based: fill a `MqlTradeRequest`, call
  `OrderSend(request, result)`, inspect `result.retcode`
  (`TRADE_RETCODE_DONE`, `TRADE_RETCODE_PLACED`, `TRADE_RETCODE_DONE_PARTIAL`,
  etc.). Always zero-initialise both structs:
  `MqlTradeRequest request = {}; MqlTradeResult result = {};`.
- Actions: `TRADE_ACTION_DEAL`, `TRADE_ACTION_PENDING`, `TRADE_ACTION_SLTP`,
  `TRADE_ACTION_MODIFY`, `TRADE_ACTION_REMOVE`, `TRADE_ACTION_CLOSE_BY`.
- Order types: `ORDER_TYPE_BUY`, `ORDER_TYPE_SELL`, `ORDER_TYPE_BUY_LIMIT`,
  `ORDER_TYPE_SELL_LIMIT`, `ORDER_TYPE_BUY_STOP`, `ORDER_TYPE_SELL_STOP`,
  `ORDER_TYPE_BUY_STOP_LIMIT`, `ORDER_TYPE_SELL_STOP_LIMIT`.
- Filling types must come from `SYMBOL_FILLING_MODE` /
  `SYMBOL_FILLING_FOK` / `SYMBOL_FILLING_IOC`, checked with
  `SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE)`. Do not hardcode
  `ORDER_FILLING_RETURN` without checking.
- Positions and orders are separate: positions are read with
  `PositionsTotal()` / `PositionGetTicket(i)` / `PositionSelectByTicket()`,
  pending orders with `OrdersTotal()` / `OrderGetTicket(i)` and
  `OrderSelect(ticket)`. There is no `OrderClose` helper in plain MQL5 — close a
  position with `TRADE_ACTION_DEAL` in the opposite direction and the position
  ticket in `request.position`.
- `CTrade` (from `<Trade\Trade.mqh>`) is the convenient wrapper:
  `trade.Buy(volume, symbol, price, sl, tp, comment)`, `trade.Sell(...)`,
  `trade.PositionClose(ticket)`, `trade.OrderModify(...)`. Check
  `trade.ResultRetcode()` after every call.
- Prices and volumes must be normalised: `NormalizeDouble(price, _Digits)` or
  `SymbolInfoInteger(symbol, SYMBOL_DIGITS)`, and volume validated against
  `SYMBOL_VOLUME_MIN` / `SYMBOL_VOLUME_MAX` / `SYMBOL_VOLUME_STEP`.


## Market data and history

- `SymbolInfoDouble(symbol, SYMBOL_BID)`, `SYMBOL_ASK`, `SYMBOL_POINT`,
  `SYMBOL_TRADE_TICK_SIZE`, `SYMBOL_TRADE_TICK_VALUE`.
- `SymbolInfoInteger(symbol, SYMBOL_DIGITS | SYMBOL_SPREAD | SYMBOL_TRADE_STOPS_LEVEL)`.
- History: `CopyRates(symbol, timeframe, start, count, rates)`,
  `CopyTime`, `CopyClose`, `CopyHigh`, `CopyLow`, `CopyTickVolume`,
  `CopyRealVolume`, `CopySpread`. Check the returned count before reading.
  `Bars(symbol, timeframe)` gives the available bar count.
- For indicator data use `CopyBuffer(handle, buffer, start, count, values)`
  after creating the handle once in `OnInit` (`iMA`, `iRSI`, `iATR`,
  `iMACD`, `iCustom`, ...). Handles must be released in `OnDeinit` with
  `IndicatorRelease(handle)`.

## Time, news and utilities

- `TimeCurrent()`, `TimeTradeServer()`, `TimeLocal()`, `TimeGMT()`,
  `TimeToStruct`, `StructToTime`, `MqlDateTime`.
- Never assume the broker's server timezone; convert explicitly.

## What good MQL5 in this session looks like

- Compiles without warnings in MetaEditor 5.
- Uses request-based trading, checks every `retcode`, and logs actionable errors
  with `PrintFormat`.
- Validates symbol/volume/price constraints before sending a request.
- Handles `OnInit` failure by returning `INIT_FAILED` and explaining why.
- Keeps indicator handles created once and released in `OnDeinit`.
- Separates strategy logic from broker plumbing so the user can test it.
