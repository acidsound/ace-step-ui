# Walkthrough: Transitioning ACE-Step UI to Full API Integration

This walkthrough documents the refactoring process to remove local Python script dependencies and transition the ACE-Step UI server to exclusively use the ACE-Step REST API for music generation and lyrics formatting.

## Motivation

Previously, the `ace-step-ui` server relied on spawning local Python subprocesses (`simple_generate.py`, `format_sample.py`) to interact with the ACE-Step backend. This approach had several drawbacks:
-   Dependency on local Python environment and correct `ACESTEP_PATH` configuration.
-   Limited scalability (difficult to run backend on a separate machine).
-   Maintenance overhead of managing local model checkpoints and environment variables on the frontend server.

The goal was to decouple the UI server from the backend implementation by utilizing the existing ACE-Step REST API.

## Changes Implemented

### 1. Formatting Endpoint Migration (`/api/generate/format`)

**Objective:** Use `POST /format_input` API instead of `format_sample.py`.

*   **`server/src/services/acestep.ts`**:
    *   Added `formatInputViaApi` function.
    *   This function checks API availability and sends a POST request to `${ACESTEP_API}/format_input`.
    *   Parameters (caption, lyrics, bpm, etc.) are structured into the JSON payload expected by the API.

*   **`server/src/routes/generate.ts`**:
    *   Removed `child_process.spawn` logic that executed `format_sample.py`.
    *   Replaced it with a call to `formatInputViaApi`.
    *   Standardized the response format to `{ success: true, ...data }` to match frontend expectations (`CreatePanel.tsx`).

*   **Deleted**: `server/scripts/format_sample.py`.

### 2. Music Generation Migration (`/api/generate`)

**Objective:** Use `POST /release_task` API instead of `simple_generate.py`.

*   **`server/src/services/acestep.ts`**:
    *   Refactored `processGeneration` function to **only** use the API path.
    *   Removed the entire fallback block that attempted to use local Python scripts if the API was unavailable.
    *   Removed `runPythonGeneration` helper function and `PythonResult` interface.
    *   Removed `checkSpaceHealth` logic that checked for local script existence; it now only checks API connectivity.
    *   Removed unused constants (`ACESTEP_DIR`, `SCRIPTS_DIR`, `PYTHON_SCRIPT`) and imports (`resolvePythonPath`, `spawn`).

*   **Deleted**: `server/scripts/simple_generate.py`.

### 3. Cleanup and Optimization

*   **`server/src/services/acestep.ts`**:
    *   Cleaned up imports (removed `spawn` from `child_process`).
    *   Removed unused path resolution logic (`resolveAceStepPath`, `resolvePythonPath`).
    *   Fixed lint errors related to deleted constants and functions.

### 4. Enhanced Metadata Support & Video Integration

**Objective:** Support advanced metadata (LRC lyrics, LLM/DiT scores) and utilize them in the Video Generator.

*   **`server/src/services/acestep.ts`**:
    *   Updated `processGeneration` to parse and map additional fields from the API response:
        *   `lrc`: Lyrics in LRC format (`[mm:ss.xx] text`).
        *   `lm_score`, `dit_score`: Generation quality scores.
        *   `sentence_timestamps`, `token_timestamps`: Precise timing data.

*   **`types.ts`**:
    *   Updated `Song` interface to include `lrc`, `lm_score`, `dit_score`, `sentence_timestamps`, and `token_timestamps`.

*   **`components/VideoGeneratorModal.tsx`**:
    *   Enhanced the lyrics parsing logic (`useEffect`).
    *   **Fallback Logic:** Now checks `song.sentence_timestamps` first (JSON format). If unavailable, falls back to parsing `song.lrc` (Text format).
    *   Implemented a local LRC parser to convert `[mm:ss.xx]` tags into `LyricSegment` objects used by the visualizer.
    *   This ensures that songs generated via the new API (which returns LRC) will automatically display noraebang lyrics in video exports.

## Result

The `ace-step-ui` server is now a lightweight client that communicates with the `ACE-Step-1.5` backend solely via HTTP REST API. This allows for:
-   **Flexibility**: The backend can be hosted on a separate, powerful GPU machine while the UI runs on a lightweight server or local machine.
-   **Simplicity**: No need to manage Python virtual environments or model paths on the UI server.
-   **Reliability**: Reduced points of failure related to local process spawning and environment mismatches.
-   **Rich Media**: Full support for synchronized lyrics and quality metrics throughout the application.
