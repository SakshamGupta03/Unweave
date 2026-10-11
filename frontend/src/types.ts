export interface Stems {
    Vocals?: string;
    Drums?: string;
    Bass?: string;
    Guitar?: string;
    Piano?: string;
    Other?: string;
    [key: string]: string | undefined;
}

export interface SeparationJob {
    job_id: string;
    stems: Stems;
    message?: string;
    processing_time?: number;
    device_used?: string;
}

export interface JobStatus {
    status: 'idle' | 'queued' | 'uploading' | 'processing' | 'complete' | 'error' | 'cancelled';
    progress: number;
    eta_seconds: number | null;
    message: string;
    stems: Stems | null;
    processing_time: number | null;
    device_used: string;
}

export interface SongItem {
    id: string;
    name: string;
    fileSize: number;
    duration: number | null;
    uploadedAt: number;
    status: 'idle' | 'queued' | 'uploading' | 'processing' | 'complete' | 'error' | 'cancelled';
    progress: number;
    etaSeconds: number | null;
    passNumber: number;
    statusMessage: string;
    jobId: string | null;
    stems: Stems | null;
    stemBlobs?: Record<string, Blob>;
    deviceUsed?: string;
    processingTime?: number;
    originalFile?: File;
    errorMessage?: string;
    separationPasses?: number;
}

export interface TimelineClip {
    id: string;
    trackId: string;
    stemName: string; // e.g. "Vocals", "Drums", etc.
    songId: string; // Reference to source song in SongLibrary
    songTitle: string;
    audioUrl: string;
    audioBlob?: Blob;
    startTime: number; // Timeline start time in seconds
    offset: number; // Start offset within the source audio buffer in seconds
    duration: number; // Playback duration in seconds on the timeline
    originalDuration: number; // Total duration of the raw audio file in seconds
    gain: number; // Clip volume multiplier (0.0 to 2.0, default 1.0)
    color: string; // Hex color for clip and waveform
    peaks?: number[]; // Pre-extracted waveform peaks
}

export interface TrackSpatialSettings {
    pattern: 'circle' | 'front-ellipse' | 'static-center';
    radius: number; // in meters (0.5 to 5.0m, default 2.5m)
    speedSeconds: number; // orbit period in seconds (3s to 24s, default 10s)
    direction: 1 | -1; // 1 = clockwise, -1 = counter-clockwise
    reverbWet: number; // 0.0 to 0.40 (default 0.12)
    elevation: number; // -1.0 to 1.5 (default 0.2)
    isCenterLocked: boolean; // Ground low-end lock
    intensity: number; // 0.0 to 1.5 (Spatial gain / intensity, default 1.0)
    crossEarSpill: number; // 0.0 to 1.0 (Opposite ear room spill, default 0.35)
}

export interface GlobalSpatialSettings {
    isManualMode: boolean; // true = Manual Studio, false = AI Auto-Guided
    is8DBypassed: boolean; // true = flat stereo, false = active 8D binaural
    masterSpeedMultiplier: number; // 0.5x, 1.0x, 1.5x, 2.0x
    reverbPreset: 'studio' | 'concert' | 'cathedral' | 'cosmic' | 'dry';
    masterSpread: number; // 0.5 to 2.0
}

export interface TimelineTrack {
    id: string;
    name: string;
    color: string;
    volume: number; // Volume fader (0.0 to 1.5, default 1.0)
    pan: number; // Stereo pan (-1.0 to +1.0, default 0.0)
    isMuted: boolean;
    isSolo: boolean;
    eqLow: number; // Low Shelf EQ gain in dB (-12 to +12, default 0)
    eqMid: number; // Peaking Mid EQ gain in dB (-12 to +12, default 0)
    eqHigh: number; // High Shelf EQ gain in dB (-12 to +12, default 0)
    spatialSettings?: TrackSpatialSettings;
}

export interface TimelineProject {
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    playheadTime: number; // Current playback position in seconds
    masterVolume: number; // Master fader (0.0 to 1.5, default 1.0)
    currentSongId?: string | null; // ID of the currently active song in timeline
    zoom: number; // Pixels per second (e.g. 50)
    duration: number; // Maximum timeline duration in seconds
    loopStart: number | null;
    loopEnd: number | null;
    isLooping: boolean;
    isSnappingEnabled: boolean;
    snapInterval: number; // in seconds (e.g. 0.5)
    globalSpatialSettings?: GlobalSpatialSettings;
}

export type WorkspaceTab = 'separate' | 'editor' | 'mixer' | 'spatial' | 'export';

export interface ExportOptions {
    target: 'master' | 'stems' | 'loop';
    format: 'wav' | 'mp3';
    bitrate: 128 | 192 | 320; // for MP3
    sampleRate: 44100 | 48000;
    normalize: boolean;
}

export interface AutoSaveMeta {
    songName: string;
    songCount?: number;
    stemCount: number;
    trackCount: number;
    lastSaved: number;
    songId?: string | null;
}

export interface AutoSaveInfo {
    exists: boolean;
    meta?: AutoSaveMeta;
}

export interface EngineState {
    status: 'checking' | 'ready' | 'needs-setup' | 'installing' | 'error';
    progress: number;
    step: string;
    detail?: string;
    logs: string[];
}

declare global {
    interface Window {
        electronAPI?: {
            isDesktop: boolean;
            platform: string;
            onMenuAction: (callback: (action: string, payload?: unknown) => void) => () => void;
            sendAction: (channel: string, data?: unknown) => void;
            invokeAction: (channel: string, data?: unknown) => Promise<unknown>;
            getAutoSaveInfo?: () => Promise<AutoSaveInfo>;
            saveAutoSaveState?: (payload: { data: unknown; meta: AutoSaveMeta }) => Promise<{ success: boolean; error?: string }>;
            loadAutoSaveState?: () => Promise<{ timelineProject?: TimelineProject; songs?: SongItem[] } | null>;
            saveAudioFile?: (filename: string, base64Data: string) => Promise<{ success: boolean; filePath?: string }>;
            loadAudioFile?: (filename: string) => Promise<string | null>;
            clearAutoSave?: () => Promise<{ success: boolean }>;
            openProjectsFolder?: () => Promise<{ success: boolean; path: string }>;
            getProjectsPath?: () => Promise<string>;
            getEngineStatus?: () => Promise<EngineState>;
            startEngineInstall?: () => Promise<{ success: boolean }>;
            repairEngine?: () => Promise<{ success: boolean }>;
            onEngineStatus?: (callback: (state: EngineState) => void) => () => void;
            openLogFile?: () => Promise<{ success: boolean; path?: string; error?: string }>;
            getLogPath?: () => Promise<string>;
        };
    }
}


