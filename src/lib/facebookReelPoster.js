// Page Reels transport. No tokens or response bodies are included in errors.
const GRAPH = 'https://graph.facebook.com/v26.0';
function createFacebookReelPoster({ fetchImpl = (...args) => fetch(...args), sleep = ms => new Promise(r => setTimeout(r, ms)), polls = 60 } = {}) {
  async function postReel({ pageId, pageAccessToken }, text, videoUrl, lifecycle = {}) {
    const { existingContainerId, onContainerCreated, onStage, assertLease = async () => {} } = lifecycle;
    if (!videoUrl || !onStage || !onContainerCreated) throw Object.assign(new Error('reel_video_and_durable_lifecycle_required'), { retrySafe: true });
    let id = existingContainerId;
    let idDurable = Boolean(id);
    let stage = lifecycle.uploadStage;
    let publishStarted = Boolean(lifecycle.publishStartedAt);
    const checkpoint = async value => { await onStage(value); stage = value; };
    async function request(url, options = {}) {
      await assertLease();
      let response;
      try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30000), redirect: 'error' }); }
      catch { throw new Error('facebook_reel_transport_unconfirmed'); }
      let json;
      try { json = await response.json(); } catch { throw new Error('facebook_reel_response_invalid'); }
      if (!response.ok || json.error) throw Object.assign(new Error('facebook_reel_api_error'), { code: `facebook_${json.error?.code || response.status}` });
      return json;
    }
    const graphPost = body => request(`${GRAPH}/${pageId}/video_reels`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pageAccessToken}` }, body: JSON.stringify(body) });
    async function finishConfirmed() {
      await checkpoint('published');
      // Thumbnail is a separate best-effort update after confirmed publication.
      // Failure here never causes another Reel to be published.
      if (lifecycle.coverBuffer) {
        const form = new FormData();
        form.set('is_preferred', 'true');
        form.set('source', new Blob([lifecycle.coverBuffer], {type:'image/jpeg'}), 'cover.jpg');
        let coverStage = 'published_cover_set';
        try { await request(`${GRAPH}/${id}/thumbnails`, {method:'POST',headers:{Authorization:`Bearer ${pageAccessToken}`},body:form}); }
        catch { coverStage = 'published_cover_unconfirmed'; }
        await checkpoint(coverStage);
      }
      return {id,containerId:id};
    }
    const status = () => request(`${GRAPH}/${id}?fields=status`, { headers: { Authorization: `Bearer ${pageAccessToken}` } });
    async function waitUntil(published) {
      for (let i = 0; i < polls; i++) {
        const result = await status();
        const s = result.status || {};
        if (s.publishing_phase?.status === 'complete') return 'published';
        if (!published && s.uploading_phase?.status === 'complete') return 'uploaded';
        if ([s.uploading_phase, s.processing_phase, s.publishing_phase].some(p => p?.status === 'error')) throw new Error('facebook_reel_processing_error');
        if (i + 1 < polls) await sleep(2000);
      }
      throw new Error('facebook_reel_processing_timeout');
    }
    try {
      if (publishStarted) {
        await waitUntil(true);
        return await finishConfirmed();
      }
      if (!id) {
        await checkpoint('start_requested');
        const started = await graphPost({ upload_phase: 'start' });
        if (!/^\d+$/.test(String(started.video_id))) throw new Error('facebook_reel_missing_video_id');
        id = String(started.video_id);
        await onContainerCreated(id);
        idDurable = true;
        await checkpoint('created');
      }
      if (stage === 'created') {
        await checkpoint('upload_requested');
        await request(`https://rupload.facebook.com/video-upload/v26.0/${id}`, { method: 'POST', headers: { Authorization: `OAuth ${pageAccessToken}`, file_url: videoUrl } });
      }
      // Existing IDs are always inspected, never replaced or blindly re-uploaded.
      const state = await waitUntil(false);
      if (state === 'published') { publishStarted = true; return await finishConfirmed(); }
      await checkpoint('uploaded');
      await checkpoint('publish_requested'); // Durable barrier BEFORE external publication.
      publishStarted = true;
      await graphPost({ upload_phase: 'finish', video_id: id, video_state: 'PUBLISHED', description: text || '' });
      await waitUntil(true);
      return await finishConfirmed();
    } catch (error) {
      // Polling/upload failures with an ID can only resume that ID. Never retry publication.
      error.retrySafe = Boolean(error.message !== 'job lease lost' && idDurable && id && !publishStarted && stage !== 'publish_requested' && stage !== 'published');
      throw error;
    }
  }
  return { postReel };
}
module.exports = { ...createFacebookReelPoster(), createFacebookReelPoster };
