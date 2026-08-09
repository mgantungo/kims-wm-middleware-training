/**
 * @fileoverview Contract every data source adapter must satisfy.
 *
 * This isn't enforced by TypeScript here (deliberately kept as plain Node
 * for a lean middleware), so it's enforced by convention: every module
 * controller calls `dataSource.<method>(...)` and never anything adapter-
 * specific. `demoDataSource.js` implements this now; `businessCentralDataSource.js`
 * implements the same surface against real Business Central OData/API
 * endpoints in Phase 2. Swapping DATA_SOURCE in .env is the only change
 * needed — no controller or route touches this.
 *
 * Method  -> Returns (shape matches the Flutter app's model fromJson exactly)
 * ------------------------------------------------------------------------
 * getPutAwayDocuments()                 -> { documents: PutAwayDocument[] }
 * getPutAwayDocument(docId)             -> PutAwayDocument
 * confirmPutAwayItem(payload)           -> { ok: true }
 * getPickDocuments()                    -> { documents: PickDocument[] }
 * getPickDocument(docId)                -> PickDocument
 * confirmPickItem(payload)              -> { ok: true }
 * getUnverifiedPicks()                  -> { picks: VerifyPick[] }
 * getVerifyPick(orderId)                -> VerifyPick
 * submitVerifyPack(payload)             -> { ok: true }
 * confirmShipLoad(payload)              -> { ok: true }
 * generateGatePass(payload)             -> GatePass
 * searchItem(query)                     -> ItemInquiryResult
 * searchBin(code)                       -> BinInquiryResult
 * trackPallet(palletId)                 -> PalletTrackingResult
 */
module.exports = {};
