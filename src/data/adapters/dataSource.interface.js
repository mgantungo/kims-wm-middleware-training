// src/data/adapters/dataSource.interface.js
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
 * saveTransfer(payload)                 -> { ok, saved, skipped, registerAttempted: false }
 *   payload: { docId, bcTransferId?, entries: [{ lineId, sku, fromBin,
 *   toBin, qty, lotNo?, serialNo?, cumulative? }] }
 *   UPDATE / PARTIAL TRANSFER. Saves taken-and-placed units as Qty. to
 *   Handle without registering. All-or-nothing; an entry whose cumulative
 *   (device total on that line and TO bin) is already held is skipped, so
 *   an outbox resend never double-counts. A TO bin other than the line's
 *   destinationBinCode is a split (Stop & Split).
 * registerTransfer(payload)             -> { ok, registered, postedQty, fullyRegistered }
 *   payload: { docId, bcTransferId?, partial?, expected?: [{ lineId,
 *   toBin, qty }] }
 *   REGISTER TRANSFER / PARTIAL REGISTER. Posts what is saved; refuses
 *   with 409 TRANSFER_QTY_MISMATCH (nothing posted) when the saved
 *   quantities differ from [expected]. Lines keep their unsaved remainder
 *   (qty = outstanding) for a later run.
 *   TransferLineItem (from getTransferDocument) now also carries: lineId,
 *   lotNo, serialNo, isLotTracked, isSerialTracked, qtyHandled,
 *   qtyToHandle, uom — qty is what is still outstanding.
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
 * confirmPutAwayBatch(payload)          -> { ok: true }
 *   payload: { docId, bcPutAwayId?, entries: [{ sku, bcLineId?, location,
 *   qty, scanLog? }] }
 *   SAVES ONLY — never registers. businessCentralDataSource.js still
 *   returns registerAttempted: false (with registered: false,
 *   registerError: null) so older app builds that read those fields keep
 *   working.
 *   Maps onto Section 2.7's Microsoft.NAV.ProcessBatchScans — replaces
 *   N separate confirmPutAwayItem calls with one call per bin/document,
 *   per product decision (line-per-line was resource-intensive on
 *   Business Central and made the operator wait on N round trips). Each
 *   entry mirrors confirmPutAwayItem's own payload shape (location/qty,
 *   not Business Central's wire names binCode/qtyToHandle — that mapping
 *   happens inside businessCentralDataSource.js). sku is carried on
 *   every entry even though businessCentralDataSource.js's version
 *   doesn't need it (Business Central addresses lines by bcLineId
 *   alone) — demoDataSource.js's version has no real bcLineId to
 *   address by, so it uses sku instead; one entry shape works for both
 *   adapters this way.
 *
 *   The SAME bcLineId can legitimately appear more than once across
 *   entries — Section 2.7's own example does exactly this for a
 *   bin-change mid-line, and a serial-tracked item (see
 *   PutAwayLineItem.isSerialTracked) relies on this too: Business
 *   Central pre-splits a serialized item into one line per physical
 *   unit BEFORE the app ever reads it (confirmed against real data,
 *   Sept 2026), so a serial-tracked line's entry always has qty 1 —
 *   there is no special per-entry serial field, since Business Central
 *   already knows which serial is on which line from receiving; the app
 *   never sends one.
 *
 *   IMPORTANT: Business Central's batch action is documented as
 *   ALL-OR-NOTHING — even a "Processed X, skipped Y" response means the
 *   WHOLE call was rolled back, not that X entries succeeded. No
 *   client-side pre-validation or partial-retry logic exists yet
 *   (deferred, per product decision, to be handled after the base batch
 *   path is working) — a rejected batch is simply retried as-is by the
 *   sync engine's normal backoff, same as any other permanently-
 *   rejected outbox entry, until the operator corrects whatever the
 *   aggregated error message named and the confirm is redone.
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
 *   payload: { binCode, sku, locationCode? }
 *   Bin-first assignment for a line Business Central left UNASSIGNED
 *   (PutAwayLineItem.location is null): the operator scans a bin before
 *   any actual UNITS are scanned, but the app already knows which LINE
 *   it's assigning a bin for at that point, so sku IS available here.
 *   locationCode (the put-away document's own header field, Section 2.4)
 *   is REQUIRED in practice against real Business Central data, even
 *   though marked optional here for demo's sake — omitting it lets a
 *   same-named bin in a totally different BC location come back
 *   "available," which then fails Business Central's own PATCH .../
 *   putAwayLines validation once actually confirmed
 *   (Internal_InvalidTableRelation). demoDataSource.js's in-memory
 *   registry tracks occupantSku, so its version can distinguish empty
 *   (accepted), occupied by the SAME sku (accepted — a legitimate
 *   top-up), and occupied by a DIFFERENT sku (rejected) — a demo-only
 *   rule. businessCentralDataSource.js's version applies NO occupancy
 *   rule at all, per product decision and the API doc (Sections 2.6 and
 *   2.7 list exactly one bin rule: the bin must exist at the put-away's
 *   location): any bin Business Central recognizes there is accepted,
 *   empty or not. It is built on the SAME GET
 *   /Bins?$filter=binCode (AND locationCode, when given) lookup
 *   searchBin uses. sku is accepted for signature parity but genuinely
 *   unused on that path. Whatever Business Central itself restricts is
 *   enforced by Business Central when the scan is pushed, and reported
 *   back to the operator as its own message.
 * registerPutAway(payload)               -> { ok: true }
 *   payload: { docId, bcPutAwayId }
 *   Whole-document "Register" event — maps onto Business Central's POST
 *   .../putAways(bcPutAwayId)/Microsoft.NAV.Register (Section 2.6), its
 *   own equivalent of pressing "Register" once every line on the
 *   document has been handled. MANUAL ONLY: called when the operator taps
 *   Register in the app, which the app allows only once every line of
 *   the document has been saved to Business Central (no put-away
 *   transaction still pending or failed — see PutAwayRepository.
 *   registerDocumentAwaited). Nothing registers automatically any more:
 *   confirmPutAwayBatch only saves, Split Bin only saves, and the list
 *   screen no longer registers complete documents on load. Replayed from
 *   the sync outbox and awaited, so the operator sees Business Central's
 *   real answer. demoDataSource.js's version is a trivial no-op
 *   ({ ok: true }).
 * getPickDocuments()                    -> { documents: PickDocument[] }
 * getPickDocument(docId)                -> PickDocument
 *   PickDocument: { docId, shipmentRef, dueDate, status, isHighPriority,
 *     items: PickLineItem[],
 *     // Business Central only (additive):
 *     bcPickId, locationCode, assignedUserId, stagingBins: string[] }
 *   PickLineItem: { sku, description, qty, location,
 *     // Business Central only (additive):
 *     bcLineId, lineNo, variantCode, lotNo, serialNo, isLotTracked,
 *     isSerialTracked, scannable, destinationBin,
 *     quantity, qtyHandled, qtyOutstanding, qtyToHandle }
 *   quantity = what the document is to handle; qtyOutstanding = what the
 *   operator is to scan (and is what qty carries).
 *   Business Central: Section 2.5, GET picks?$expand=pickLines. Only Take
 *   lines become items (BC syncs Place lines itself, Section 2.9.5); qty
 *   is qtyOutstanding (the scan target); picks with nothing outstanding are omitted.
 *   status is always 'assigned' from a BC read — qtyToHandle's meaning
 *   on an untouched line is not yet confirmed against live data (see
 *   businessCentralDataSource.js's _mapPick), so progress stays with the
 *   app's own local scan state. shipmentRef/isHighPriority have no BC
 *   equivalent (pick number / false); dueDate is the assignment date.
 * confirmPickItem(payload)              -> { ok: true }
 *   Demo: { docId, sku, scanLog? }. Business Central: Section 2.9
 *   UpdateLineScan, payload { bcLineId, location, qty, lotNo?, serialNo? }
 *   — one scan, real-time. Not de-duplicated by BC: never resend a scan
 *   that already succeeded.
 * confirmPickBatch(payload)             -> { ok: true, registerAttempted,
 *                                            registered, registerError }
 *   payload: { docId, bcPickId?, register?, entries: [{ sku, bcLineId?,
 *   location, qty, cumulative?, lotNo?, serialNo? }] }. qty is the units
 *   picked from that bin in this save (an increment); cumulative is all
 *   saved on that line in that bin, this save included (resend check).
 *   Business Central: Section 2.10 ProcessBatchScans (all-or-nothing).
 *   register: false (Update Pick / Partial Pick) saves only; otherwise
 *   Section 2.11 Register follows straight away. Register's outcome is
 *   reported, never thrown: the scans are already saved by then, and
 *   resending them would double-count. The same bcLineId may repeat
 *   (bin change mid-line triggers BC's own split, Section 2.10.4).
 * checkPickBin(payload)                 -> { available, reason?, availableQty? }
 *   payload: { binCode, sku, lotNo?, serialNo?, locationCode? } — can this
 *   item be taken from the bin the operator scanned? Business Central:
 *   Section 2.2.2 bin contents, scoped to the pick's location. Demo:
 *   always available. Routed by PICK_READ_SOURCE (read-only).
 * registerPick(payload)                 -> { ok: true, fullyRegistered }
 *   payload: { docId, bcPickId?, partial?, expected? } — Section 2.11.
 *   Partial registration is allowed: unsaved quantity stays outstanding
 *   on the same pick. expected ([{ bcLineId, bin, qty }]) is what the app
 *   saved and has not registered; when sent, Register is refused (409,
 *   nothing posted) if Business Central's Qty. to Handle differs from it.
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
 * searchItem(query, { locationCode? })  -> ItemInquiryResult
 *   Item Inquiry. [query] is whatever was scanned or typed: tried as a
 *   barcode, then an item number, then part of an item name (a single
 *   name match only; several matches -> 400 listing them; none -> 404).
 *   [locationCode] (the operator's own, from the JWT) limits stockLines
 *   to that location.
 *   Business Central: Section 2.3.1 — GET itemInquiries?$filter=
 *   barcodeFilter eq '...' (or itemNo eq '...'); name search and the
 *   uom / tracking flags come from Section 2.3 (GET items), cached 10 min.
 *   Shape:
 *     { sku, name, stockLines: ItemStockLine[],
 *       // additive (Business Central only — absent from demo):
 *       matchedBy: 'barcode' | 'itemNo' | 'name', query, variantCode,
 *       locationCode, uom?, hasVariants?, hasBatches?, hasSerials?,
 *       summary: { totalQty, lineCount, binCount, lotCount, locationCount },
 *       lastSyncedAt }
 *   ItemStockLine: { zone, location, bin, qty, batch,
 *     // Business Central only: lotNo, serialNo, palletNo, variantCode
 *     // Demo only: receivedDate, receivedBy (no BC source — not sent) }
 *   qty can be a decimal. An item that exists but has no stock (at this
 *   location) comes back with an empty stockLines, not a 404.
 *   demoDataSource.js ignores both arguments and returns a fixed item.
 * searchBin(code, { locationCode? })    -> BinInquiryResult
 *   Bin Inquiry's primary action — the operator scans the bin in front
 *   of them. [code] is whatever was scanned or typed and is matched
 *   against binCode OR binBarCode. [locationCode] (the operator's own,
 *   from the JWT) scopes the lookup; without it, a code shared by bins in
 *   several locations fails with a clear "exists in more than one
 *   location" error rather than silently picking one.
 *   Business Central: Section 2.2.2 — GET Bins?$expand=binContentLines(
 *   $expand=palletAndLots)&$filter=..., one round trip.
 *   Shape:
 *     { binCode, location, isActive, items, contentsAvailable,
 *       lastSyncedAt, binDescription?, binTypeCode?, zoneCode?, isEmpty?,
 *       // additive (Business Central only — absent from demo):
 *       locationCode, binBarCode, matchedBy: 'binCode' | 'binBarCode',
 *       crossDockBin, warehouseClassCode, binRanking, maximumCubage,
 *       contents: BinContentLine[],
 *       summary: { itemCount, lineCount, lotCount, hasAllocations } }
 *   BinContentLine: { itemNo, itemName, variantCode, unitOfMeasureCode,
 *     quantity, pickQty, putAwayQty, availableQty, lots: BinLot[] }
 *     availableQty = max(0, quantity - pickQty); putAwayQty is inbound
 *     and is not subtracted.
 *   BinLot: { lotNo, serialNo, packageNo, unitOfMeasureCode, quantity }
 *   `items` ({ name, sku, batch, units }, one row per lot) is the legacy
 *   flat list, derived from `contents`, kept so older app builds keep
 *   rendering. New app code should read `contents`. itemName comes from
 *   Section 2.3 (GET /items), cached for 10 minutes; it falls back to
 *   itemNo if that lookup fails — never an error. demoDataSource.js
 *   accepts and ignores the second argument and returns the legacy shape
 *   only.
 * listBins(locationCode?)               -> { bins: BinSummary[] }
 *   The "browse all bins" view (secondary — opened from Bin Inquiry's
 *   side menu, loaded on demand) — unfiltered Section 2.2 (GET /Bins) on
 *   the Business Central side, the shared in-memory _binRegistry
 *   (unfiltered) on the demo side. Distinct from searchBin above, which
 *   looks up exactly one binCode. Field shape per bin: { binCode,
 *   isEmpty, occupantSku?, capacity?, currentQty?, binDescription?,
 *   locationCode?, zoneCode?, binTypeCode?, binBarCode? } — binCode/
 *   isEmpty are meaningful from both sources; occupantSku/capacity/
 *   currentQty are demo-only (no Business Central equivalent — /Bins has
 *   no contents or capacity field, same gap as searchBin above);
 *   binDescription/locationCode/zoneCode/binTypeCode/binBarCode are
 *   Business-Central-only (demo's _binRegistry has no such metadata).
 *   Never guess a value for a field the current source can't actually
 *   provide — omit it, same convention as searchBin.
 * trackPallet(palletId)                 -> { palletNo, binCode, zoneCode,
 *                                            locationCode, status, lastMovedAt,
 *                                            contents: [{ itemNo, description,
 *                                            lotNo, serialNo, qty, uom }],
 *                                            history: [{ at, fromBinCode,
 *                                            toBinCode, by }] }
 *   A pallet sits in ONE bin and its contents move together. 404 when the
 *   pallet is not known. (Legacy palletId / lastLocation / lastTimestamp
 *   and name / sku / batch / units are also returned for older builds.)
 * movePallet({ palletNo, toBinCode, by })-> { ok, fromBinCode, pallet }
 *   Moves the whole pallet to another bin. Live, never queued. 400 with a
 *   readable reason when the bin is unknown, doesn't take pallets or is
 *   full. Demo only for now — no Business Central endpoint is documented.
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