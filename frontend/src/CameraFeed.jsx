import { useState, useEffect, useRef } from 'react';
import { apiFetch, apiUrl } from './api';

export default function CameraFeed({ id, address, name, recording, manualRecord, fps, recStartedAt, battery, connected, sleepEnabled, frameSize, onExpand, onRename }) {
  const [error, setError] = useState(false);
  const [busy,  setBusy]  = useState(false);
  const [sleepBusy, setSleepBusy] = useState(false);
  const [sizeBusy, setSizeBusy]   = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [elapsed, setElapsed] = useState('');
  const inputRef = useRef(null);
  const retryTimer = useRef(null);

  useEffect(() => {
    if (!recording || !recStartedAt) { setElapsed(''); return; }
    const tick = () => {
      const s = Math.floor((Date.now() - recStartedAt) / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      setElapsed(h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
        : `${m}:${String(sec).padStart(2,'0')}`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [recording, recStartedAt]);

  // When stream errors, retry after 3 s
  const handleError = () => {
    setError(true);
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      setStreamKey(k => k + 1);
      setError(false);
    }, 3_000);
  };

  useEffect(() => () => clearTimeout(retryTimer.current), []);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const startEdit = (e) => {
    e.stopPropagation();
    setEditValue(name || '');
    setEditing(true);
  };

  const commitEdit = async () => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed === (name || '')) return;
    try {
      await apiFetch(`/cameras/${id}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (onRename) onRename(id, trimmed || null);
    } catch { /* ignore — server will refresh via SSE */ }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') commitEdit();
    else if (e.key === 'Escape') setEditing(false);
    e.stopPropagation();
  };

  const toggleRecording = async (e) => {
    e.stopPropagation(); // don't expand tile
    if (busy) return;
    setBusy(true);
    const action = recording ? 'stop' : 'start';
    try {
      await apiFetch(`/record/${id}/${action}`, { method: 'POST' });
    } finally {
      setBusy(false);
    }
  };

  const toggleSleep = async (e) => {
    e.stopPropagation();
    if (sleepBusy) return;
    setSleepBusy(true);
    try {
      await apiFetch(`/cameras/${id}/sleep`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !sleepEnabled }),
      });
    } finally {
      setSleepBusy(false);
    }
  };

  const SIZES = [
    { key: 'SXGA', label: 'SXGA', title: '1280×1024' },
    { key: 'UXGA', label: 'UXGA', title: '1600×1200' },
    { key: 'FHD',  label: 'FHD',  title: '1920×1080' },
    { key: 'QXGA', label: 'QXGA', title: '2048×1536' },
  ];

  const changeFrameSize = async (e) => {
    e.stopPropagation();
    if (sizeBusy) return;
    setSizeBusy(true);
    try {
      await apiFetch(`/cameras/${id}/framesize`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frameSize: e.target.value }),
      });
    } finally {
      setSizeBusy(false);
    }
  };

  const displayName = name || id;

  const FRAME_DIMS = { SXGA: [1280, 1024], UXGA: [1600, 1200], FHD: [1920, 1080], QXGA: [2048, 1536] };
  const [fw, fh] = FRAME_DIMS[frameSize] ?? FRAME_DIMS.QXGA;

  return (
    <div
      className={`tile${!connected ? ' tile--offline' : ''}`}
      style={{ aspectRatio: `${fw} / ${fh}` }}
      onClick={onExpand}
      title={connected ? 'Click to expand' : 'Camera offline'}
    >
      {!connected ? (
        <div className="tile-offline">
          <p>Off</p>
          <p className="hint">{displayName}</p>
        </div>
      ) : error ? (
        <div className="tile-error">
          <p>No signal</p>
          <p className="hint">{displayName}</p>
        </div>
      ) : (
        <img
            key={streamKey}
            src={apiUrl(`/stream/${id}`)}
            alt={displayName}
            className="tile-img"
            onError={handleError}
            onLoad={() => setError(false)}
          />
      )}
      <div className="tile-label" onClick={e => e.stopPropagation()}>
        {editing ? (
          <input
            ref={inputRef}
            className="tile-name-input"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={handleKeyDown}
            maxLength={64}
            placeholder={id}
          />
        ) : (
          <>
            <span className="tile-name" title="Double-click to rename" onDoubleClick={startEdit}>
              {displayName}
            </span>
            {fps != null ? <span className="tile-fps"> · {fps} fps</span> : ''}
            {battery != null ? <span className="tile-battery"> · 🔋 {battery}%</span> : ''}
          </>
        )}
      </div>
      {recording && (
        <div className={`tile-rec${manualRecord ? ' tile-rec--manual' : ''}`}>
          ● {manualRecord ? 'REC (manual)' : 'REC'}{elapsed ? ` ${elapsed}` : ''}
        </div>
      )}
      {battery != null && battery < 5 && (
        <div className="tile-bat-low">🔋 BATTERY LOW {battery}%</div>
      )}
      {connected && (
        <button
          className={`tile-rec-btn${recording ? ' tile-rec-btn--stop' : ''}`}
          onClick={toggleRecording}
          disabled={busy}
          title={recording ? 'Stop recording' : 'Start recording'}
        >
          {recording ? '⏹' : '⏺'}
        </button>
      )}
      <button
        className={`tile-sleep-btn${sleepEnabled ? ' tile-sleep-btn--on' : ''}`}
        onClick={toggleSleep}
        disabled={sleepBusy}
        title={sleepEnabled ? 'Wake camera' : 'Put camera to sleep'}
      >
        {sleepEnabled ? '▶' : '⏾'}
      </button>

      {connected && (
        <select
          className="tile-size-select"
          value={frameSize ?? 'QXGA'}
          onChange={changeFrameSize}
          onClick={e => e.stopPropagation()}
          disabled={sizeBusy}
          title="Change resolution"
        >
          {SIZES.map(s => (
            <option key={s.key} value={s.key} title={s.title}>{s.label}</option>
          ))}
        </select>
      )}
    </div>
  );
}


