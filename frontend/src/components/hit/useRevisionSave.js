import { useRef, useState } from 'react';
import { fetchHitRun, saveHitMask } from '../../api.js';

function requestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** One receipt per explicit save. A retry after a lost response reuses that receipt. */
export default function useRevisionSave() {
  const attempt = useRef(null);
  const [conflict, setConflict] = useState(null);
  const override = useRef(null);

  function clear() {
    attempt.current = null;
    override.current = null;
    setConflict(null);
  }

  async function persist(job, task, payload, username, metadata) {
    const expected = override.current ? override.current.id : metadata.expected_head;
    const descriptor = JSON.stringify([
      job,
      username,
      payload.masks.largevessel,
      metadata.parent,
      metadata.threshold,
      expected,
    ]);
    if (attempt.current?.descriptor !== descriptor) {
      attempt.current = { descriptor, id: requestId() };
    }
    const request = { ...metadata, expected_head: expected, request_id: attempt.current.id };
    try {
      const result = await saveHitMask(job, task, payload, request);
      clear();
      return result;
    } catch (err) {
      if (err.status === 409) {
        const fresh = await fetchHitRun(job);
        const head = fresh.versions.find((version) => version.username === username);
        setConflict({
          head,
          currentMask: head?.mask_url ?? fresh.outputs.mask,
          draft: payload.masks.largevessel,
        });
      }
      throw err;
    }
  }

  function keepDraft() {
    if (!conflict) return;
    override.current = { id: conflict.head?.id ?? null };
    attempt.current = null;
    setConflict(null);
  }

  return { persist, conflict, keepDraft, clear };
}
