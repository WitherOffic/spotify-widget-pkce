/*
 * Wither Spotify Widget — text transition renderer.
 * Modified project, 2026. Licensed under GNU GPL version 3; see LICENSE.
 */
export function createTextTransition(viewport, titleNode, artistNode, { enabled = true } = {}) {
  const animations = new Set();
  const ghosts = new Set();

  function cancel() {
    for (const animation of animations) {
      try { animation.cancel(); } catch { /* already finished */ }
    }
    animations.clear();
    for (const ghost of ghosts) ghost.remove();
    ghosts.clear();
  }
  function makeGhost(title, artist) {
    const ghost = document.createElement('div');
    ghost.className = 'track-text-ghost';
    const titleEl = document.createElement('div');
    titleEl.className = 'track-text-ghost-title';
    titleEl.textContent = title;
    const artistEl = document.createElement('div');
    artistEl.className = 'track-text-ghost-artist';
    artistEl.textContent = artist;
    ghost.append(titleEl, artistEl);
    return ghost;
  }
  function animate(title, artist, hadPreviousTrack) {
    const oldTitle = titleNode.textContent;
    const oldArtist = artistNode.textContent;
    cancel();
    titleNode.textContent = title;
    artistNode.textContent = artist;

    if (!enabled || typeof titleNode.animate !== 'function') return;
    if (hadPreviousTrack && (oldTitle !== title || oldArtist !== artist)) {
      const ghost = makeGhost(oldTitle, oldArtist);
      viewport.appendChild(ghost);
      ghosts.add(ghost);
      const outgoing = ghost.animate([
        { opacity: 1, transform: 'translate3d(0,0,0)', filter: 'blur(0px)' },
        { opacity: 0, transform: 'translate3d(-42px,0,0)', filter: 'blur(4px)' },
      ], { duration: 340, easing: 'cubic-bezier(.55,.03,.83,.45)', fill: 'both' });
      animations.add(outgoing);
      void outgoing.finished.then(
        () => { ghosts.delete(ghost); ghost.remove(); animations.delete(outgoing); },
        () => { ghosts.delete(ghost); ghost.remove(); animations.delete(outgoing); },
      );
    }

    const frames = [
      { opacity: 0, transform: 'translate3d(42px,0,0)', filter: 'blur(4px)' },
      { opacity: 1, transform: 'translate3d(0,0,0)', filter: 'blur(0px)' },
    ];
    const nameIn = titleNode.animate(frames, {
      duration: 520, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both',
    });
    const artistIn = artistNode.animate(frames, {
      duration: 550, delay: 70, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both',
    });
    animations.add(nameIn);
    animations.add(artistIn);
    void artistIn.finished.then(() => {
      if (animations.has(artistIn)) cancel();
    }, () => {});
  }
  return { animate, cancel };
}
