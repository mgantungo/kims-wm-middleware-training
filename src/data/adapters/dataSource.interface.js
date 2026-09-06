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
 *   payload.scanLog (optional): [{ sequence, scannedAt }] — the per-unit
 *   accepted-scan timeline behind payload.qty, when the item was scanned
 *   unit-by-unit rather than confirmed as a single quantity. Additive only;
 *   adapters that don't care about it can ignore the field.
 * validatePutAwayBin(payload)           -> { accepted: boolean, reason?: string }
 *   payload: { docId, binCode, sku, qty }
 *   Operator-scanned-candidate path — kept for a possible future manual
 *   override, not currently wired to the app's "Stop & Split" button.
 * suggestPutAwayBin(payload)            -> { available: boolean, binCode?, isTopUp?, currentQty?, capacityRemaining?, reason? }
 *   payload: { docId, sku, qty, excludeBinCode? }
 *   "Stop & Split" flow: the operator does NOT choose a bin — this asks
 *   Business Central to find one with enough free capacity for the
 *   remainder, which may be an empty bin OR a "topup" of a bin already
 *   holding the same sku (isTopUp: true, with currentQty being that bin's
 *   quantity BEFORE this reservation). available: false is a normal
 *   response (no suitable bin right now), not an error — only missing
 *   required fields should throw ApiError.badRequest, same convention as
 *   confirmPutAwayItem/validatePutAwayBin.
 * getPickDocuments()                    -> { documents: PickDocument[] }
 * getPickDocument(docId)                -> PickDocument
 * confirmPickItem(payload)              -> { ok: true }
 *   payload.scanLog (optional): same shape as confirmPutAwayItem above.
 *
 * Scan exceptions (wrong item / wrong bin / item not on this document,
 * pushed immediately as they happen rather than bundled with a confirm
 * call) are handled OUTSIDE this adapter interface entirely — see
 * src/data/scanExceptionStore.js and src/modules/scanLogging/. They are
 * middleware-generated audit records, not data read from or written
 * through to Business Central, so they don't participate in the
 * DATA_SOURCE=demo|businessCentral swap.
 * getUnverifiedPicks()                  -> { picks: VerifyPick[] }
 * getVerifyPick(orderId)                -> VerifyPick
 * submitVerifyPack(payload)             -> { ok: true }
 *   payload.items[].scanLog (optional): [{ sequence, scannedAt }] — per-item
 *   accepted-scan timeline, same shape as confirmPutAwayItem's scanLog.
 *   Captured by verifyPack.controller.js into verifyAuditStore.js BEFORE
 *   this call, since DemoDataSource removes the pick from its unverified
 *   list as part of handling it — adapters don't need to do anything with
 *   this field themselves unless they want to.
 * confirmShipLoad(payload)              -> { ok: true }
 * generateGatePass(payload)             -> GatePass
 * searchItem(query)                     -> ItemInquiryResult
 * searchBin(code)                       -> BinInquiryResult
 * trackPallet(palletId)                 -> PalletTrackingResult
 *
 * -- Item Transfer -----------------------------------------------------
 * getTransferSourceBin(binCode)         -> { binCode: string, items: [{ sku, description, availableQty }] }
 *   Ad-hoc entry point: unlike Put Away/Pick, Transfer has no assigned
 *   document to select first. The operator scans whatever bin they're
 *   standing at and this returns what's genuinely there to move. An empty
 *   `items` array is a normal response (empty/unrecognized bin), not an
 *   error.
 * validateTransferBin(payload)          -> { accepted: boolean, reason?: string }
 *   payload: { sourceBinCode, destinationBinCode, sku, qty }
 *   Live, blocking, never outbox-queued — same reasoning as
 *   validatePutAwayBin. Checks the destination has enough free capacity
 *   AND (is empty OR already holds the same sku) — a bin holding a
 *   different sku is always rejected, regardless of capacity.
 * confirmTransfer(payload)              -> { ok: true }
 *   payload: { sourceBinCode, destinationBinCode, sku, qty, reasonCode?,
 *   reasonNote?, scanLog? }
 *   Local-first / outbox-queued on the client, same as confirmPutAwayItem.
 *   Decrements the source bin's on-hand qty and increments the
 *   destination's by [qty] — this is a real stock movement, not a flag.
 *   reasonCode is one of 'repair' | 'consolidation' | 'other' | null
 *   (optional — Transfer's reason is not required, unlike Quarantine's).
 */
module.exports = {};