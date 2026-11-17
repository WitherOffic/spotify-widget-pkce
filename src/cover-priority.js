/*
 * Wither Spotify Widget — prefer the public oEmbed cover without blocking
 * on a slow/unavailable Spotify image CDN. The direct Worker URL remains
 * a delayed backup; the first successfully decoded image wins.
 */
export async function preferPublicCover({
  lookupPublic,
  backupUrl,
  probe,
  graceMs = 1000,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  let publicSucceeded = false;
  const preferred = (async () => {
    const url = await lookupPublic();
    if (!url || !(await probe(url))) throw new Error("Public artwork unavailable");
    publicSucceeded = true;
    return url;
  })();

  const backup = (async () => {
    // Start the backup immediately on public failure, or after a brief
    // grace period when the public endpoint is taking too long.
    await Promise.race([delay(graceMs), preferred.then(() => {}, () => {})]);
    if (publicSucceeded || !backupUrl) throw new Error("Backup not needed");
    if (!(await probe(backupUrl))) throw new Error("Backup artwork unavailable");
    return backupUrl;
  })();

  try {
    return await Promise.any([preferred, backup]);
  } catch {
    return null;
  }
}
