import { useEffect, useState, useRef } from 'react';
import { apiFetch, apiUrl } from './api';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString('en-GB');
}

function formatDuration(secs) {
  if (secs == null) return '—';
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export default function RecordingsManager({ onClose = () => {}, cameraNames, uiScale = 1, inline = false }) {
  const [recordings, setRecordings] = useState({}); // { camId: [{name, size, mtime}] }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(null); // { camId, file }
  const [deleting, setDeleting] = useState(null); // { camId, file }
  const [confirmDelete, setConfirmDelete] = useState(null); // { camId, file }
  const [preview, setPreview] = useState(null); // { camId, file, x, y }
  const videoRef = useRef(null);

  const load = () => {
    setLoading(true);
    setError(null);
    apiFetch('/recordings')
      .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(d.error)))
      .then(data => { setRecordings(data); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { if (playing) setPlaying(null); else onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, onClose]);

  const handlePlay = (camId, file) => {
    setPlaying({ camId, file });
  };

  const handleDownload = (camId, file) => {
    const a = document.createElement('a');
    a.href = apiUrl(`/recordings/${encodeURIComponent(camId)}/${encodeURIComponent(file)}/download`);
    a.download = file;
    a.click();
  };

  const handleDeleteConfirm = (camId, file) => {
    setConfirmDelete({ camId, file });
  };

  const handleDeleteExecute = async () => {
    if (!confirmDelete) return;
    const { camId, file } = confirmDelete;
    setDeleting({ camId, file });
    setConfirmDelete(null);
    try {
      const r = await apiFetch(`/recordings/${encodeURIComponent(camId)}/${encodeURIComponent(file)}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      setRecordings(prev => {
        const updated = { ...prev };
        updated[camId] = updated[camId].filter(f => f.name !== file);
        if (updated[camId].length === 0) delete updated[camId];
        return updated;
      });
    } catch (e) {
      setError(String(e));
    }
    setDeleting(null);
  };

  const camIds = Object.keys(recordings);
  const totalFiles = camIds.reduce((s, id) => s + recordings[id].length, 0);

  // The modals (player, confirm, preview) always render as fixed overlays
  const modals = (
    <>
      {playing && (
        <div className="rec-player-overlay" onClick={() => setPlaying(null)}>
          <button className="rec-close-btn" onClick={(e) => { e.stopPropagation(); setPlaying(null); }} aria-label="Close">✕</button>
          <div className="rec-player-box" onClick={e => e.stopPropagation()}>
            <div style={{ zoom: uiScale }} className="rec-player-header">
              <span className="rec-player-title">{playing.file}</span>
            </div>
            <video
              ref={videoRef}
              className="rec-video"
              controls
              autoPlay
            >
              <source
                src={apiUrl(`/recordings/${encodeURIComponent(playing.camId)}/${encodeURIComponent(playing.file)}`)}
                type="video/mp4"
              />
            </video>
          </div>
        </div>
      )}

      {preview && (
        <img
          className="rec-preview-thumb"
          src={apiUrl(`/recordings/${encodeURIComponent(preview.camId)}/${encodeURIComponent(preview.file)}/thumb`)}
          alt="preview"
          style={{ left: preview.x + 16, top: preview.y + 16 }}
        />
      )}

      {confirmDelete && (
        <div className="rec-confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="rec-confirm-box" style={{ zoom: uiScale }} onClick={e => e.stopPropagation()}>
            <div className="rec-confirm-title">Delete recording?</div>
            <div className="rec-confirm-file">{confirmDelete.file}</div>
            <div className="rec-confirm-actions">
              <button className="rec-btn rec-btn-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="rec-btn rec-btn-del-confirm" onClick={handleDeleteExecute}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  const panelContent = (
    <div className={`rec-panel${inline ? ' rec-panel--inline' : ''}`} onClick={e => e.stopPropagation()}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="rec-header">
          <span className="rec-title">Recordings</span>
          {!loading && <span className="rec-subtitle">{totalFiles} file{totalFiles !== 1 ? 's' : ''} across {camIds.length} camera{camIds.length !== 1 ? 's' : ''}</span>}
        </div>

        <div className="rec-body">
          {loading && <div className="rec-empty">Loading…</div>}
          {error && <div className="rec-error">{error}</div>}
          {!loading && !error && camIds.length === 0 && (
            <div className="rec-empty">No recordings found.</div>
          )}
          {!loading && !error && camIds.map(camId => (
            <div key={camId} className="rec-camera-group">
              <div className="rec-camera-label">
                {(cameraNames && cameraNames[camId]) || camId}
              </div>
              <table className="rec-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Duration</th>
                    <th>Size</th>
                    <th>Date</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {recordings[camId].map(f => (
                    <tr
                      key={f.name}
                      className={deleting?.camId === camId && deleting?.file === f.name ? 'rec-row-deleting' : ''}
                      onMouseEnter={e => setPreview({ camId, file: f.name, x: e.clientX, y: e.clientY })}
                      onMouseMove={e => setPreview(p => p ? { ...p, x: e.clientX, y: e.clientY } : p)}
                      onMouseLeave={() => setPreview(null)}
                    >
                      <td className="rec-filename">{f.name}</td>
                      <td className="rec-duration">{formatDuration(f.duration)}</td>
                      <td className="rec-size">{formatSize(f.size)}</td>
                      <td className="rec-date">{formatDate(f.mtime)}</td>
                      <td className="rec-actions">
                        <button className="rec-btn rec-btn-play" onClick={() => handlePlay(camId, f.name)} title="Play">▶</button>
                        <button className="rec-btn rec-btn-dl" onClick={() => handleDownload(camId, f.name)} title="Download">↓</button>
                        <button className="rec-btn rec-btn-del" onClick={() => handleDeleteConfirm(camId, f.name)} title="Delete">🗑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (inline) {
    return (
      <>
        {panelContent}
        {modals}
      </>
    );
  }

  return (
    <div className="rec-overlay" style={{ zoom: 1 / uiScale }} onClick={onClose}>
      <button className="rec-close-btn" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Close">✕</button>
      {panelContent}
      {modals}
    </div>
  );
}

