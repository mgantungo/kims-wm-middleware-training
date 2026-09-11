// src/data/dataSource.interface.js
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
 * -- Item Transfer (document-driven, per Klan's process: Business Central
 * decides which bins move where — the app never lets an operator choose a
 * destination) ------------------------------------------------------------
 * getTransferDocuments()                -> { documents: TransferDocument[] }
 * getTransferDocument(docId)            -> TransferDocument
 *   TransferDocument: { docId, status, items: TransferLineItem[] }
 *   TransferLineItem: { sku, description, qty, sourceBinCode,
 *   destinationBinCode, scannable }. Both bins arrive pre-assigned from
 *   Business Central — many-to-one (consolidation) is several lines
 *   sharing one destinationBinCode; one-to-many (split placement) is
 *   several lines sharing one sourceBinCode+sku with different
 *   destinationBinCodes and split quantities. The app groups lines into
 *   "stops" by sourceBinCode (the physical bin the operator walks to),
 *   exactly the way PutAwayDocument groups by destination location.
 * validateTransferSplitBin(payload)     -> { accepted: boolean, reason?: string }
 *   payload: { docId, binCode, sku, qty }
 *   SPLIT-ONLY — never used to decide a line's original destination
 *   (that's always pre-assigned by Business Central, see above). This
 *   exists for the case where the operator physically arrives at the
 *   assigned destination and finds it short of room: they scan a
 *   candidate replacement bin for the remainder, and this asks Business
 *   Central to accept/reject it live — same reasoning as Put Away's
 *   validatePutAwayBin. accepted: false is a normal response (scan a
 *   different bin), not an error.
 * suggestTransferSplitBin(payload)      -> { available: boolean, binCode?, isTopUp?, currentQty?, capacityRemaining?, reason? }
 *   payload: { docId, sku, qty, excludeBinCode? }
 *   SPLIT-ONLY, same scope as validateTransferSplitBin but Business
 *   Central picks the bin itself (the "Auto-Assign" path) rather than
 *   judging one the operator scanned — identical semantics to
 *   suggestPutAwayBin, including the isTopUp/currentQty fields.
 * confirmTransferItem(payload)          -> { ok: true }
 *   payload: { docId, sku, sourceBinCode, destinationBinCode, qty,
 *   scanLog? }
 *   Local-first / outbox-queued on the client, identical convention to
 *   confirmPutAwayItem. No live validate/suggest-bin calls exist for
 *   Transfer anymore — since Business Central already decided both bins
 *   before the document was assigned, the operator's source/destination
 *   scans are a physical confirmation gate (does the scanned bin match
 *   what BC said?), not a decision the server needs to approve live.
 *
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
 *   payload: { docId, sku, qty, excludeBinCodes? }
 *   "Stop & Split" flow: the operator does NOT choose a bin — this asks
 *   Business Central to find one with enough free capacity for the
 *   remainder, which may be an empty bin OR a "topup" of a bin already
 *   holding the same sku (isTopUp: true, with currentQty being that bin's
 *   quantity BEFORE this reservation). excludeBinCodes covers EVERY bin
 *   already belonging to the document, not just the one line came up
 *   short — an auto-assigned remainder must never land in a bin already
 *   tied to this same task. available: false is a normal response (no
 *   suitable bin right now), not an error — only missing required fields
 *   should throw ApiError.badRequest, same convention as
 *   confirmPutAwayItem/validatePutAwayBin.
 * checkPutAwayBin(payload)               -> { available: boolean, reason?: string }
 *   payload: { binCode, sku }
 *   Bin-first assignment for a line Business Central left UNASSIGNED
 *   (PutAwayLineItem.location is null): the operator scans a bin before
 *   any actual UNITS are scanned, but the app already knows which LINE
 *   it's assigning a bin for at that point, so sku IS available here.
 *   Deliberately simpler than validatePutAwayBin though — no qty is
 *   known/relevant yet, so this never checks CAPACITY, only whether the
 *   bin's occupant (if any) is unrelated to sku: empty -> accepted,
 *   occupied by the SAME sku -> accepted (a legitimate top-up), occupied
 *   by a DIFFERENT sku -> rejected. MOCKED in demoDataSource.js pending a
 *   real Business Central bin/location lookup.
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
 * -- Quarantine (document-driven, per Klan's control requirement: same
 * pattern as Item Transfer above — the plan comes from Business Central,
 * the operator only executes and confirms via scanning) -------------------
 * getQuarantineDocuments()              -> { documents: QuarantineDocument[] }
 * getQuarantineDocument(docId)          -> QuarantineDocument
 *   QuarantineDocument: { docId, status, items: QuarantineLineItem[] }
 *   QuarantineLineItem: { sku, description, qty, sourceBinCode,
 *   destinationBinCode, reasonCode, reasonNote, scannable }. Unlike
 *   Transfer's optional reason, every quarantine line carries a
 *   reasonCode decided by Business Central when the document was created
 *   ('damaged' | 'expired' | 'qualityHold' | 'other', with reasonNote set
 *   when 'other') — the operator sees it, never chooses it. Lines group
 *   into stops by sourceBinCode exactly like TransferDocument.
 * validateQuarantineSplitBin(payload)   -> { accepted: boolean, reason?: string }
 *   payload: { docId, binCode, sku, qty }
 *   SPLIT-ONLY, same scope as validateTransferSplitBin: the operator
 *   arrived at the assigned quarantine bin and found it short, and is
 *   scanning a candidate replacement. UNLIKE Transfer's split (which can
 *   land in any bin with capacity), the replacement here must ALSO be
 *   flagged as a quarantine zone — damaged stock cannot land in an
 *   ordinary picking bin just because that bin had room.
 * suggestQuarantineSplitBin(payload)    -> { available: boolean, binCode?, isTopUp?, currentQty?, capacityRemaining?, reason? }
 *   payload: { docId, sku, qty, excludeBinCode? }
 *   SPLIT-ONLY auto-assign, restricted to quarantine-zone-flagged bins.
 * confirmQuarantineItem(payload)        -> { ok: true }
 *   payload: { docId, sku, sourceBinCode, destinationBinCode, qty,
 *   scanLog? }
 *   Local-first / outbox-queued on the client, identical convention to
 *   confirmTransferItem. The original destination-approval concern that
 *   made confirm live/blocking in this module's original ad-hoc design no
 *   longer applies — Business Central approves the quarantine zone when
 *   the document is created, and any later split-remainder destination is
 *   already live-approved via validateQuarantineSplitBin/
 *   suggestQuarantineSplitBin before this is ever called.
 */
module.exports = {};