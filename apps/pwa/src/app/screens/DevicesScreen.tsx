// [D1] Settings ▸ Devices — the entry to adding a device (flows §2, §7). EU-8 builds only
// "＋ Add a device"; the device list, removing a device and "Lost a device?" are EU-9.

import { PAIRING_COPY } from "../../device/pairing-copy.js";

export function DevicesScreen({
  online,
  onAdd,
  onBack,
}: {
  readonly online: boolean;
  readonly onAdd: () => void;
  readonly onBack: () => void;
}) {
  return (
    <div className="lock pairing" data-testid="devices-screen">
      <div className="lockbody">
        <h2>Devices</h2>
        <button
          type="button"
          className="btn primary wide"
          disabled={!online}
          onClick={onAdd}
          data-testid="add-device"
        >
          ＋ Add a device
        </button>
        {online ? null : <p className="locknote">{PAIRING_COPY.offlineAdd}</p>}
        <button type="button" className="backlink" onClick={onBack}>
          ‹ Dashboard
        </button>
      </div>
    </div>
  );
}
