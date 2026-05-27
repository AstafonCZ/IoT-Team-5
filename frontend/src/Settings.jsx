import { useEffect, useState } from 'react';
import { apiFetch } from './api';

export default function Settings({ onClose, uiScale = 1.0, onScaleChange, inline = false }) {
  const [motionEnabled,    setMotionEnabled]    = useState(true);
  const [noMotionSecs,     setNoMotionSecs]     = useState(180);
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const [recordOnBell,     setRecordOnBell]     = useState(false);
  const [maxStorageGB,     setMaxStorageGB]     = useState(10);
  const [manualRecordMins, setManualRecordMins] = useState(30);
  const [timezone,         setTimezone]         = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState('');
  const [uiScaleInput, setUiScaleInput] = useState(String(Math.round(uiScale * 100)));

  useEffect(() => {
    setUiScaleInput(String(Math.round(uiScale * 100)));
  }, [uiScale]);

  // Load current settings from the server when the panel opens
  useEffect(() => {
    apiFetch('/settings')
      .then(r => r.json())
      .then(data => {
        setMotionEnabled(data.motionEnabled);
        setNoMotionSecs(data.noMotionSecs);
        setRecordingEnabled(data.recordingEnabled);
        setRecordOnBell(data.recordOnBell ?? false);
        setMaxStorageGB(data.maxStorageGB);
        setManualRecordMins(data.manualRecordMins);
        setTimezone(data.timezone);
      })
      .catch(() => setError('Failed to load settings'));
  }, []);

  const save = async () => {
    setError('');
    setSaved(false);
    setSaving(true);
    try {
      const res = await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          motionEnabled,
          noMotionSecs:     Number(noMotionSecs),
          recordingEnabled,
          recordOnBell,
          maxStorageGB:     Number(maxStorageGB),
          manualRecordMins: Number(manualRecordMins),
          timezone,
        }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError('Save failed');
      }
    } catch {
      setError('Cannot reach server');
    } finally {
      setSaving(false);
    }
  };

  const applyUiScaleInput = () => {
    const value = Number(uiScaleInput);

    if (!Number.isFinite(value)) {
      setUiScaleInput(String(Math.round(uiScale * 100)));
      return;
    }

    const clamped = Math.min(150, Math.max(70, value));
    setUiScaleInput(String(clamped));
    onScaleChange(clamped / 100);
  };

  const panel = (
    <div className={`settings-panel${inline ? ' settings-panel--inline' : ''}`} onClick={e => e.stopPropagation()}>
      <div className="settings-header">
        <span className="settings-title">Settings</span>
        {!inline && onClose && <button className="settings-close" onClick={onClose} aria-label="Close">✕</button>}
      </div>

        <div className="settings-section-label">Motion Detection</div>

        <label className="settings-row">
          <span className="settings-row-label">Reduce fps when no motion</span>
          <div
            className={`toggle ${motionEnabled ? 'toggle--on' : ''}`}
            onClick={() => setMotionEnabled(v => !v)}
            role="switch"
            aria-checked={motionEnabled}
          >
            <div className="toggle-thumb" />
          </div>
        </label>

        {(motionEnabled || recordingEnabled) && (
          <label className="settings-row">
            <span className="settings-row-label">
              Active duration after motion
              <span className="settings-row-hint"> (seconds)</span>
            </span>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={3600}
              value={noMotionSecs}
              onChange={e => setNoMotionSecs(e.target.value)}
            />
          </label>
        )}

        <div className="settings-section-label">Recording</div>

        <label className="settings-row">
          <span className="settings-row-label">Save video on motion</span>
          <div
            className={`toggle ${recordingEnabled ? 'toggle--on' : ''}`}
            onClick={() => setRecordingEnabled(v => !v)}
            role="switch"
            aria-checked={recordingEnabled}
          >
            <div className="toggle-thumb" />
          </div>
        </label>

        <label className="settings-row">
          <span className="settings-row-label">Record on bell button press</span>
          <div
            className={`toggle ${recordOnBell ? 'toggle--on' : ''}`}
            onClick={() => setRecordOnBell(v => !v)}
            role="switch"
            aria-checked={recordOnBell}
          >
            <div className="toggle-thumb" />
          </div>
        </label>

        <label className="settings-row">
          <span className="settings-row-label">
            Max storage
            <span className="settings-row-hint"> (GB)</span>
          </span>
          <input
            className="settings-input"
            type="number"
            min={1}
            max={1000}
            step={1}
            value={maxStorageGB}
            onChange={e => setMaxStorageGB(e.target.value)}
          />
        </label>

        <label className="settings-row">
          <span className="settings-row-label">
            Manual recording duration
            <span className="settings-row-hint"> (minutes)</span>
          </span>
          <input
            className="settings-input"
            type="number"
            min={1}
            max={1440}
            step={1}
            value={manualRecordMins}
            onChange={e => setManualRecordMins(e.target.value)}
          />
        </label>

        <div className="settings-section-label">Display</div>

        <label className="settings-row">
          <span className="settings-row-label">
            UI scale
            <span className="settings-row-hint"> (70–150%)</span>
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              className="settings-input"
              type="number"
              min={70}
              max={150}
              step={5}
              value={uiScaleInput}
              onChange={e => setUiScaleInput(e.target.value)}
              onBlur={applyUiScaleInput}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              style={{ width: 80 }}
            />
            <span className="settings-row-hint">%</span>
          </div>
        </label>

        <div className="settings-section-label">General</div>

        <label className="settings-row">
          <span className="settings-row-label">
            Timezone
            <span className="settings-row-hint"> (IANA name)</span>
          </span>
          <input
            className="settings-input settings-input--wide"
            type="text"
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            placeholder="Europe/London"
            spellCheck={false}
          />
        </label>

        {error && <div className="settings-error">{error}</div>}

        <div className="settings-footer">
          {saved && <span className="settings-saved">Saved</span>}
          <button className="settings-save-btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
  );

  if (inline) return panel;

  return (
    <div className="settings-overlay" onClick={onClose}>
      {panel}
    </div>
  );
}