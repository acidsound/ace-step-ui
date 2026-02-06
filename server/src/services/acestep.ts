import { writeFile, mkdir, copyFile, rm, stat, access } from 'fs/promises';
import { execSync } from 'child_process';
import { existsSync, createWriteStream } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

// Get audio duration using ffprobe
function getAudioDuration(filePath: string): number {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const duration = parseFloat(result.trim());
    return isNaN(duration) ? 0 : Math.round(duration);
  } catch (error) {
    console.warn('Failed to get audio duration:', error);
    return 0;
  }
}
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, '../../public/audio');

const ACESTEP_API = config.acestep.apiUrl;


const ACESTEP_DIR = resolveAceStepPath();

// Resolve ACE-Step path (from env or default relative path)
// Kept for ACESTEP_DIR reference if needed for other things (e.g. static files?)
// But we should probably remove it if we want full decouple.
// However `getAudioDuration` uses ffprobe on local files, which is fine.
// Let's remove Python specific paths.

function resolveAceStepPath(): string {
  const envPath = process.env.ACESTEP_PATH;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  return path.resolve(__dirname, '../../../../ACE-Step-1.5');
}

// Cache API availability status (check once, remember for session)
let apiAvailableCache: boolean | null = null;
let apiCheckPromise: Promise<boolean> | null = null;

// Check if ACE-Step API is running
async function isApiAvailable(): Promise<boolean> {
  // Return cached result if available
  if (apiAvailableCache !== null) {
    return apiAvailableCache;
  }

  // Prevent multiple concurrent checks
  if (apiCheckPromise) {
    return apiCheckPromise;
  }

  apiCheckPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${ACESTEP_API}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        apiAvailableCache = data.status === 'ok' || data.healthy === true || data.data?.status === 'ok';
        console.log(`[ACE-Step] API available at ${ACESTEP_API}: ${apiAvailableCache}`);
        return apiAvailableCache;
      }
      apiAvailableCache = false;
      return false;
    } catch (error) {
      console.log(`[ACE-Step] API not available at ${ACESTEP_API}, will use Python spawn`);
      apiAvailableCache = false;
      return false;
    } finally {
      apiCheckPromise = null;
    }
  })();

  return apiCheckPromise;
}

// Reset API cache (useful if API starts/stops)
export function resetApiCache(): void {
  apiAvailableCache = null;
  apiCheckPromise = null;
}

// Submit generation job to ACE-Step API
async function submitToApi(params: GenerationParams): Promise<{ taskId: string }> {
  // 1. Prepare common parameters
  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);
  const lyrics = params.instrumental ? '' : (params.lyrics || '');

  const body: Record<string, unknown> = {
    prompt,
    lyrics,
    audio_duration: params.duration ?? 60,
    batch_size: params.batchSize ?? 1,
    inference_steps: params.inferenceSteps ?? 8,
    guidance_scale: params.guidanceScale ?? 10.0,
    audio_format: params.audioFormat ?? 'mp3',
    vocal_language: params.vocalLanguage || 'en',
    use_random_seed: params.randomSeed !== false,
    shift: params.shift ?? 3.0,
    thinking: params.thinking ?? false, // Respect frontend choice, default false for GPU compatibility
    use_cot_caption: false, // Explicitly disable CoT features that require LLM
    use_cot_language: false, // Explicitly disable CoT features that require LLM
    use_cot_metas: false, // Explicitly disable CoT features that require LLM
  };

  if (params.bpm && params.bpm > 0) body.bpm = params.bpm;
  if (params.keyScale) body.key_scale = params.keyScale;
  if (params.timeSignature) body.time_signature = params.timeSignature;
  if (params.seed !== undefined && params.seed >= 0 && !params.randomSeed) {
    body.seed = params.seed;
    body.use_random_seed = false;
  }
  if (params.taskType && params.taskType !== 'text2music') body.task_type = params.taskType;
  if (params.audioCodes) body.audio_code_string = params.audioCodes;
  if (params.repaintingStart !== undefined && params.repaintingStart > 0) body.repainting_start = params.repaintingStart;
  if (params.repaintingEnd !== undefined && params.repaintingEnd > 0) body.repainting_end = params.repaintingEnd;
  if (params.audioCoverStrength !== undefined && params.audioCoverStrength !== 1.0) body.audio_cover_strength = params.audioCoverStrength;
  if (params.instruction) body.instruction = params.instruction;
  // LLM and CoT parameters only sent when thinking mode is enabled
  if (params.thinking) {
    if (params.lmTemperature !== undefined) body.lm_temperature = params.lmTemperature;
    if (params.lmCfgScale !== undefined) body.lm_cfg_scale = params.lmCfgScale;
    if (params.lmTopK !== undefined && params.lmTopK > 0) body.lm_top_k = params.lmTopK;
    if (params.lmTopP !== undefined) body.lm_top_p = params.lmTopP;
    if (params.useCotCaption !== undefined) body.use_cot_caption = params.useCotCaption;
    if (params.useCotLanguage !== undefined) body.use_cot_language = params.useCotLanguage;
    if (params.useCotMetas !== undefined) body.use_cot_metas = params.useCotMetas;
  }
  if (params.useAdg) body.use_adg = true;
  if (params.cfgIntervalStart !== undefined && params.cfgIntervalStart > 0) body.cfg_interval_start = params.cfgIntervalStart;
  if (params.cfgIntervalEnd !== undefined && params.cfgIntervalEnd < 1.0) body.cfg_interval_end = params.cfgIntervalEnd;

  // 2. Resolve local file paths for reference/source audio
  let refAudioPath: string | null = null;
  let srcAudioPath: string | null = null;

  if (params.referenceAudioUrl) {
    refAudioPath = params.referenceAudioUrl;
    if (refAudioPath.startsWith('/audio/')) {
      refAudioPath = path.join(AUDIO_DIR, refAudioPath.replace('/audio/', ''));
    }
  }

  if (params.sourceAudioUrl) {
    srcAudioPath = params.sourceAudioUrl;
    if (srcAudioPath.startsWith('/audio/')) {
      srcAudioPath = path.join(AUDIO_DIR, srcAudioPath.replace('/audio/', ''));
    }
  }

  // 3. Determine request method (Multipart vs JSON)
  const hasFiles = refAudioPath || srcAudioPath;

  if (hasFiles) {
    console.log('[ACE-Step] Sending request with FormData (Files included)');
    const formData = new FormData();

    // Append standard fields
    for (const [key, value] of Object.entries(body)) {
      formData.append(key, String(value));
    }

    // Append files
    const { readFile } = await import('fs/promises'); // Dynamic import for safety

    if (refAudioPath) {
      try {
        const fileBuffer = await readFile(refAudioPath);
        const blob = new Blob([fileBuffer]);
        formData.append('ref_audio', blob, path.basename(refAudioPath));
      } catch (err) {
        console.warn(`[ACE-Step] Failed to read reference audio: ${refAudioPath}`, err);
        // Fallback: send path string if file fails
        formData.append('reference_audio_path', refAudioPath);
      }
    }

    if (srcAudioPath) {
      try {
        const fileBuffer = await readFile(srcAudioPath);
        const blob = new Blob([fileBuffer]);
        formData.append('src_audio', blob, path.basename(srcAudioPath));
      } catch (err) {
        console.warn(`[ACE-Step] Failed to read source audio: ${srcAudioPath}`, err);
        // Fallback: send path string if file fails
        formData.append('src_audio_path', srcAudioPath);
      }
    }

    const response = await fetch(`${ACESTEP_API}/release_task`, {
      method: 'POST',
      body: formData, // Content-Type header set automatically with boundary
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error (Multipart): ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const taskId = result.data?.task_id || result.data?.job_id || result.job_id || result.task_id;
    if (!taskId) throw new Error('No task ID returned from API (Multipart)');
    return { taskId };

  } else {
    // Legacy JSON path (no files to upload)
    console.log('[ACE-Step] Sending request with JSON');

    // Explicitly set null/empty paths if not present, to match previous behavior if needed?
    // Actually, explicit nulls often break things, better to just omit or send if we had them (which we don't here).

    const response = await fetch(`${ACESTEP_API}/release_task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error (JSON): ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const taskId = result.data?.task_id || result.data?.job_id || result.job_id || result.task_id;
    if (!taskId) throw new Error('No task ID returned from API (JSON)');
    return { taskId };
  }
}

// Poll API for job result
interface ApiAudioDetail {
  file: string;
  lrc?: string;
  sentence_timestamps?: any[];
  token_timestamps?: any[];
  lm_score?: number;
  dit_score?: number;
}

interface ApiTaskResult {
  status: number; // 0 = processing, 1 = done, 2 = failed
  audioPaths: string[];
  audioDetails?: ApiAudioDetail[];
  metas?: {
    bpm?: number;
    duration?: number;
    genres?: string;
    keyscale?: string;
    timesignature?: string;
  };
}

async function pollApiResult(taskId: string, maxWaitMs = 600000): Promise<ApiTaskResult> {
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds

  while (Date.now() - startTime < maxWaitMs) {
    const response = await fetch(`${ACESTEP_API}/query_result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id_list: [taskId] }),
    });

    if (!response.ok) {
      throw new Error(`API poll error: ${response.status}`);
    }

    const result = await response.json();
    const taskData = result.data?.[0];

    if (!taskData) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      continue;
    }

    // Status: 0 = processing, 1 = done, 2 = failed
    if (taskData.status === 1) {
      // Parse result JSON
      let resultData;
      try {
        resultData = typeof taskData.result === 'string' ? JSON.parse(taskData.result) : taskData.result;
      } catch {
        resultData = [];
      }

      const audioPaths = Array.isArray(resultData)
        ? resultData.map((r: { file?: string }) => r.file).filter(Boolean)
        : [];
      const metas = resultData[0]?.metas;

      // Extract new details if present (resultData is the list of audio results)
      const audioDetails = Array.isArray(resultData) ? resultData : [];

      return { status: 1, audioPaths, metas, audioDetails };
    } else if (taskData.status === 2) {
      throw new Error('Generation failed on API side');
    }

    // Still processing
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error('API generation timeout');
}

// Download audio from API
async function downloadAudioFromApi(audioPath: string, destPath: string): Promise<void> {
  // Check if audioPath is already a relative URL (starts with /v1/audio)
  const url = audioPath.startsWith('/v1/audio')
    ? `${ACESTEP_API}${audioPath}`
    : `${ACESTEP_API}/v1/audio?path=${encodeURIComponent(audioPath)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const body = response.body;
  if (!body) {
    throw new Error('No response body');
  }

  await mkdir(path.dirname(destPath), { recursive: true });
  const fileStream = createWriteStream(destPath);

  // Convert web ReadableStream to Node stream
  const reader = body.getReader();
  const nodeStream = new (await import('stream')).Readable({
    async read() {
      const { done, value } = await reader.read();
      if (done) {
        this.push(null);
      } else {
        this.push(Buffer.from(value));
      }
    }
  });

  await pipeline(nodeStream, fileStream);
}

export interface GenerationParams {
  // Mode
  customMode: boolean;

  // Simple Mode
  songDescription?: string;

  // Custom Mode
  lyrics: string;
  style: string;
  title: string;

  // Common
  instrumental: boolean;
  vocalLanguage?: string;

  // Music Parameters
  duration?: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;

  // Generation Settings
  inferenceSteps?: number;
  guidanceScale?: number;
  batchSize?: number;
  randomSeed?: boolean;
  seed?: number;
  thinking?: boolean;
  audioFormat?: 'mp3' | 'flac';
  inferMethod?: 'ode' | 'sde';
  shift?: number;

  // LM Parameters
  lmTemperature?: number;
  lmCfgScale?: number;
  lmTopK?: number;
  lmTopP?: number;
  lmNegativePrompt?: string;

  // Expert Parameters
  referenceAudioUrl?: string;
  sourceAudioUrl?: string;
  audioCodes?: string;
  repaintingStart?: number;
  repaintingEnd?: number;
  instruction?: string;
  audioCoverStrength?: number;
  taskType?: string;
  useAdg?: boolean;
  cfgIntervalStart?: number;
  cfgIntervalEnd?: number;
  customTimesteps?: string;
  useCotMetas?: boolean;
  useCotCaption?: boolean;
  useCotLanguage?: boolean;
  autogen?: boolean;
  constrainedDecodingDebug?: boolean;
  allowLmBatch?: boolean;
  getScores?: boolean;
  getLrc?: boolean;
  scoreScale?: number;
  lmBatchChunkSize?: number;
  trackName?: string;
  completeTrackClasses?: string[];
  isFormatCaption?: boolean;
}

interface GenerationResult {
  audioUrls: string[];
  duration: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  lrc?: string;
  lm_score?: number;
  dit_score?: number;
  sentence_timestamps?: any[];
  token_timestamps?: any[];
  status: string;
}

interface JobStatus {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  queuePosition?: number;
  etaSeconds?: number;
  result?: GenerationResult;
  error?: string;
}

interface ActiveJob {
  params: GenerationParams;
  startTime: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  taskId?: string;
  result?: GenerationResult;
  error?: string;
  processPromise?: Promise<void>;
  rawResponse?: unknown;
  queuePosition?: number;
}

const activeJobs = new Map<string, ActiveJob>();

// Job queue for sequential processing (GPU can only handle one job at a time)
const jobQueue: string[] = [];
let isProcessingQueue = false;

// Health check - verify API connectivity
export async function checkSpaceHealth(): Promise<boolean> {
  return await isApiAvailable();
}

// Discover endpoints (for compatibility)
export async function discoverEndpoints(): Promise<unknown> {
  return { provider: 'acestep-remote', endpoint: ACESTEP_API };
}

// Reset client (no-op for REST API)
export function resetClient(): void {
  // No client to reset for REST API
}

// Process the job queue sequentially
async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (jobQueue.length > 0) {
    const jobId = jobQueue[0];
    const job = activeJobs.get(jobId);

    if (job && job.status === 'queued') {
      try {
        await processGeneration(jobId, job.params, job);
      } catch (error) {
        console.error(`Queue processing error for ${jobId}:`, error);
      }
    }

    // Remove from queue after processing (whether success or failure)
    jobQueue.shift();

    // Update queue positions for remaining jobs
    jobQueue.forEach((id, index) => {
      const queuedJob = activeJobs.get(id);
      if (queuedJob) {
        queuedJob.queuePosition = index + 1;
      }
    });
  }

  isProcessingQueue = false;
}

// Submit generation job to queue
export async function generateMusicViaAPI(params: GenerationParams): Promise<{ jobId: string }> {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const job: ActiveJob = {
    params,
    startTime: Date.now(),
    status: 'queued',
    queuePosition: jobQueue.length + 1,
  };

  activeJobs.set(jobId, job);
  jobQueue.push(jobId);

  console.log(`Job ${jobId}: Queued at position ${job.queuePosition}`);

  // Start processing the queue (will be a no-op if already processing)
  processQueue().catch(err => console.error('Queue processing error:', err));

  return { jobId };
}

async function processGeneration(
  jobId: string,
  params: GenerationParams,
  job: ActiveJob
): Promise<void> {
  job.status = 'running';

  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);
  const lyrics = params.instrumental ? '' : (params.lyrics || '');

  // Check if ACE-Step API is available
  const useApi = await isApiAvailable();

  if (useApi) {
    console.log(`Job ${jobId}: Using ACE-Step REST API`, {
      prompt: prompt.slice(0, 50),
      duration: params.duration,
    });

    try {
      // Submit to API
      const { taskId } = await submitToApi(params);
      console.log(`Job ${jobId}: Submitted to API as task ${taskId}`);

      // Poll for result
      const apiResult = await pollApiResult(taskId);

      if (!apiResult.audioPaths || apiResult.audioPaths.length === 0) {
        throw new Error('No audio files generated by API');
      }

      // Download audio files from API to local storage
      const audioUrls: string[] = [];
      let actualDuration = 0;
      const audioFormat = params.audioFormat ?? 'mp3';

      for (const apiAudioPath of apiResult.audioPaths) {
        const ext = apiAudioPath.includes('.flac') ? '.flac' : `.${audioFormat}`;
        const filename = `${jobId}_${audioUrls.length}${ext}`;
        const destPath = path.join(AUDIO_DIR, filename);

        await downloadAudioFromApi(apiAudioPath, destPath);

        if (audioUrls.length === 0) {
          actualDuration = getAudioDuration(destPath);
        }

        audioUrls.push(`/audio/${filename}`);
      }

      const finalDuration = actualDuration > 0
        ? actualDuration
        : (apiResult.metas?.duration || params.duration || 60);

      const firstAudioDetail = apiResult.audioDetails?.[0];

      console.log(`[ACE-Step] Audio Detail for Job ${jobId}:`, {
        hasLrc: !!firstAudioDetail?.lrc,
        lrcLength: firstAudioDetail?.lrc?.length,
        items: Object.keys(firstAudioDetail || {}),
        sentence_timestamps: firstAudioDetail?.sentence_timestamps,
        raw: firstAudioDetail
      });

      job.status = 'succeeded';
      job.result = {
        audioUrls,
        duration: finalDuration,
        bpm: apiResult.metas?.bpm || params.bpm,
        keyScale: apiResult.metas?.keyscale || params.keyScale,
        timeSignature: apiResult.metas?.timesignature || params.timeSignature,
        lrc: firstAudioDetail?.lrc,
        lm_score: firstAudioDetail?.lm_score,
        dit_score: firstAudioDetail?.dit_score,
        sentence_timestamps: firstAudioDetail?.sentence_timestamps,
        token_timestamps: firstAudioDetail?.token_timestamps,
        status: 'succeeded',
      };
      console.log(`Job ${jobId}: Completed via API with ${audioUrls.length} audio files`);

    } catch (error) {
      console.error(`Job ${jobId}: API generation failed`, error);
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'API generation failed';
    }
  } else {
    // API not available and we removed local fallback
    console.error(`Job ${jobId}: ACE-Step API not available`);
    job.status = 'failed';
    job.error = 'ACE-Step API not available';
  }
}

export async function formatInputViaApi(params: {
  caption: string;
  lyrics: string;
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
  temperature?: number;
}): Promise<any> {
  // Check API availability first
  const useApi = await isApiAvailable();

  if (!useApi) {
    throw new Error('ACE-Step API is not available for formatting');
  }

  const payload = {
    prompt: params.caption,
    lyrics: params.lyrics,
    temperature: params.temperature,
    param_obj: JSON.stringify({
      bpm: params.bpm,
      duration: params.duration,
      key_scale: params.keyScale,
      time_signature: params.timeSignature
    })
  };

  try {
    const response = await fetch(`${ACESTEP_API}/format_input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    if (result.code !== 200) {
      throw new Error(result.error || 'Format failed');
    }

    return result.data;
  } catch (error) {
    console.error('[ACE-Step] Format API error:', error);
    throw error;
  }
}





function extractAudioFiles(result: unknown): string[] {
  const urls: string[] = [];

  function processItem(item: unknown): void {
    if (!item) return;

    if (typeof item === 'string') {
      if (item.includes('.mp3') || item.includes('.wav') || item.includes('.flac')) {
        urls.push(item);
      }
      return;
    }

    if (Array.isArray(item)) {
      for (const subItem of item) {
        processItem(subItem);
      }
      return;
    }

    if (typeof item === 'object') {
      const obj = item as Record<string, unknown>;

      // Check common audio path fields
      if (obj.audio_path && typeof obj.audio_path === 'string') {
        urls.push(obj.audio_path);
      }
      if (obj.path && typeof obj.path === 'string') {
        urls.push(obj.path);
      }
      if (obj.url && typeof obj.url === 'string') {
        urls.push(obj.url);
      }
      if (obj.file && typeof obj.file === 'string') {
        urls.push(obj.file);
      }

      // Recursively check arrays and objects
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (Array.isArray(val) || (typeof val === 'object' && val !== null)) {
          processItem(val);
        }
      }
    }
  }

  processItem(result);
  return [...new Set(urls)];
}

// Get job status
export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const job = activeJobs.get(jobId);

  if (!job) {
    return {
      status: 'failed',
      error: 'Job not found',
    };
  }

  if (job.status === 'succeeded' && job.result) {
    return {
      status: 'succeeded',
      result: job.result,
    };
  }

  if (job.status === 'failed') {
    return {
      status: 'failed',
      error: job.error || 'Generation failed',
    };
  }

  const elapsed = Math.floor((Date.now() - job.startTime) / 1000);

  // Include queue position if queued
  if (job.status === 'queued') {
    return {
      status: job.status,
      queuePosition: job.queuePosition,
      etaSeconds: (job.queuePosition || 1) * 180, // ~3 min per job estimate
    };
  }

  return {
    status: job.status,
    etaSeconds: Math.max(0, 180 - elapsed), // 3 min estimate
  };
}

// Get raw response for debugging
export function getJobRawResponse(jobId: string): unknown | null {
  const job = activeJobs.get(jobId);
  return job?.rawResponse || null;
}

// Get audio stream from local file or remote URL
export async function getAudioStream(audioPath: string): Promise<Response> {
  // If it's already a full URL, fetch directly
  if (audioPath.startsWith('http')) {
    return fetch(audioPath);
  }

  // If it's a local /audio/ path, read from filesystem
  if (audioPath.startsWith('/audio/')) {
    const localPath = path.join(AUDIO_DIR, audioPath.replace('/audio/', ''));
    try {
      const { readFile } = await import('fs/promises');
      const buffer = await readFile(localPath);
      const ext = localPath.endsWith('.flac') ? 'flac' : 'mpeg';
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': `audio/${ext}` }
      });
    } catch (err) {
      console.error('Failed to read local audio file:', localPath, err);
      return new Response(null, { status: 404 });
    }
  }

  // Otherwise, use the ACE-Step audio endpoint
  const url = `${ACESTEP_API}/v1/audio?path=${encodeURIComponent(audioPath)}`;
  console.log('Fetching audio from:', url);
  return fetch(url);
}

// Download audio to local storage
export async function downloadAudio(remoteUrl: string, songId: string): Promise<string> {
  await mkdir(AUDIO_DIR, { recursive: true });

  const response = await getAudioStream(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const ext = remoteUrl.includes('.flac') ? '.flac' : '.mp3';
  const filename = `${songId}${ext}`;
  const filepath = path.join(AUDIO_DIR, filename);

  await writeFile(filepath, Buffer.from(buffer));
  console.log(`Downloaded audio to ${filepath}`);

  return `/audio/${filename}`;
}

// Download audio to buffer
export async function downloadAudioToBuffer(remoteUrl: string): Promise<{ buffer: Buffer; size: number }> {
  const response = await getAudioStream(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return { buffer, size: buffer.length };
}

// Cleanup job from memory
export function cleanupJob(jobId: string): void {
  activeJobs.delete(jobId);
}

// Cleanup old jobs
export function cleanupOldJobs(maxAgeMs: number = 3600000): void {
  const now = Date.now();
  for (const [jobId, job] of activeJobs) {
    if (now - job.startTime > maxAgeMs) {
      activeJobs.delete(jobId);
    }
  }
}
