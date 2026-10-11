import React, { useState, useRef, useEffect } from 'react';
import { Cpu, RefreshCw, AlertTriangle, CheckCircle, Terminal, ChevronDown, ChevronUp, Sparkles, Wrench, FileText } from 'lucide-react';
import type { EngineState } from '../../types';

interface EngineSetupModalProps {
    engineState: EngineState;
    onStartInstall: () => void;
    onRepair: () => void;
    onClose?: () => void;
}

function getLogLineColor(log: string): string {
    const lower = log.toLowerCase();
    if (lower.includes('[error]') || lower.includes('[timeout]') || lower.includes('[fatal')) {
        return 'text-rose-400';
    }
    if (lower.includes('[success]') || lower.includes('ok') && lower.includes('setup completed')) {
        return 'text-emerald-400';
    }
    if (lower.includes('[setup]') || lower.includes('[status]')) {
        return 'text-amber-300';
    }
    return 'text-zinc-400';
}

export const EngineSetupModal: React.FC<EngineSetupModalProps> = ({
    engineState,
    onStartInstall,
    onRepair,
    onClose,
}) => {
    const [showLogs, setShowLogs] = useState(false);
    const logsEndRef = useRef<HTMLDivElement>(null);

    const isInstalling = engineState.status === 'installing';
    const isError = engineState.status === 'error';
    const isNeedsSetup = engineState.status === 'needs-setup';
    const isReady = engineState.status === 'ready';

    const isDesktop = typeof window !== 'undefined' && Boolean(window.electronAPI?.isDesktop);
    const platform = window.electronAPI?.platform || 'unknown';
    const platformName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';

    // Auto-scroll logs to bottom
    useEffect(() => {
        if (showLogs && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [showLogs, engineState.logs?.length]);

    const handleOpenLogFile = async () => {
        if (window.electronAPI?.openLogFile) {
            await window.electronAPI.openLogFile();
        }
    };

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/85 backdrop-blur-2xl animate-in fade-in duration-300">
            <div
                className="bg-zinc-950/95 border border-amber-500/30 rounded-3xl w-full max-w-xl shadow-[0_25px_70px_rgba(0,0,0,0.95)] p-6 sm:p-8 relative space-y-6 animate-in zoom-in-95 duration-200 overflow-hidden text-zinc-100"
                style={{ backdropFilter: 'blur(28px)' }}
            >
                {/* Background Ambient Aura Glow */}
                <div className="absolute -top-20 -right-20 w-56 h-56 bg-amber-500/15 rounded-full blur-3xl pointer-events-none" />
                <div className="absolute -bottom-20 -left-20 w-56 h-56 bg-orange-600/15 rounded-full blur-3xl pointer-events-none" />

                {/* Header */}
                <div className="flex items-start gap-4">
                    <div className={`p-4 rounded-2xl shrink-0 shadow-lg ${
                        isError
                            ? 'bg-rose-500/15 border border-rose-500/30 text-rose-400 shadow-[0_0_25px_rgba(244,63,94,0.25)]'
                            : isReady
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 shadow-[0_0_25px_rgba(16,185,129,0.25)]'
                            : 'bg-amber-500/15 border border-amber-500/30 text-amber-400 shadow-[0_0_25px_rgba(245,158,11,0.25)]'
                    }`}>
                        {isError ? (
                            <AlertTriangle className="w-7 h-7" />
                        ) : isReady ? (
                            <CheckCircle className="w-7 h-7" />
                        ) : isInstalling ? (
                            <RefreshCw className="w-7 h-7 animate-spin" />
                        ) : (
                            <Cpu className="w-7 h-7" />
                        )}
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${
                                isError
                                    ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                                    : isReady
                                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                                    : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                            }`}>
                                {isError ? 'Engine Error' : isReady ? 'Engine Ready' : isInstalling ? 'Setting Up AI Engine' : 'First-Launch Setup'}
                            </span>
                        </div>
                        <h2 className="text-xl font-bold text-white tracking-tight">
                            {isError
                                ? 'AI Engine Setup Issue'
                                : isReady
                                ? 'Unweave AI Ready'
                                : isInstalling
                                ? 'Initializing Unweave AI Engine'
                                : 'Prepare Unweave AI Engine'}
                        </h2>
                        <p className="text-zinc-400 text-xs mt-1 leading-relaxed">
                            {isError
                                ? 'Could not automatically configure the Python AI backend environment. You can retry or rebuild the environment. Check the log file for details.'
                                : isReady
                                ? 'The standalone AI separation engine and hardware acceleration are configured and active.'
                                : isInstalling
                                ? `Setting up PyTorch & Demucs neural network isolation engine natively on your ${platformName} computer. This happens once and takes ~1-2 minutes.`
                                : `To run studio-grade 6-stem separation natively on your ${platformName} computer, Unweave sets up a dedicated environment in your application data folder.`}
                        </p>
                    </div>
                </div>

                {/* Progress Bar & Status Details (When Installing or Ready) */}
                {(isInstalling || isReady) && (
                    <div className="space-y-2.5 bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4">
                        <div className="flex justify-between items-center text-xs font-mono">
                            <span className="text-amber-300 font-medium flex items-center gap-2">
                                <Sparkles className="w-3.5 h-3.5 animate-pulse text-amber-400" />
                                {engineState.step || 'Processing...'}
                            </span>
                            <span className="text-zinc-400 font-bold">{Math.round(engineState.progress)}%</span>
                        </div>

                        {/* Animated Progress Bar */}
                        <div className="w-full h-2.5 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800/80 p-0.5">
                            <div
                                className={`h-full rounded-full transition-all duration-300 ease-out ${
                                    isReady
                                        ? 'bg-gradient-to-r from-emerald-500 to-teal-400 shadow-[0_0_12px_rgba(16,185,129,0.5)]'
                                        : 'bg-gradient-to-r from-amber-500 via-yellow-400 to-orange-500 shadow-[0_0_12px_rgba(245,158,11,0.5)]'
                                }`}
                                style={{ width: `${Math.max(4, Math.min(100, engineState.progress))}%` }}
                            />
                        </div>

                        {engineState.detail && (
                            <p className="text-[11px] text-zinc-400 truncate font-mono">
                                {engineState.detail}
                            </p>
                        )}
                    </div>
                )}

                {/* Needs Setup Info Card */}
                {isNeedsSetup && (
                    <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 text-xs space-y-2 text-zinc-300">
                        <div className="flex items-center gap-2 font-semibold text-zinc-200">
                            <Sparkles className="w-4 h-4 text-amber-400" />
                            <span>What happens during initial setup?</span>
                        </div>
                        <ul className="space-y-1.5 text-zinc-400 pl-5 list-disc marker:text-amber-500">
                            <li>Creates an isolated Python virtual environment in your application data folder</li>
                            <li>Installs native PyTorch & Demucs neural network isolation wheels</li>
                            <li>Auto-activates available GPU hardware acceleration (Metal / CUDA / CPU fallback)</li>
                            <li>Completely self-contained: subsequent launches take less than 1 second</li>
                        </ul>
                    </div>
                )}

                {/* Error Banner */}
                {isError && (
                    <div className="bg-rose-950/30 border border-rose-500/30 rounded-2xl p-4 text-xs space-y-2">
                        <p className="text-rose-200 font-medium">Error Details:</p>
                        <p className="text-rose-300 font-mono text-[11px] break-all bg-black/40 p-2 rounded-lg border border-rose-900/50">
                            {engineState.detail || 'An unknown error occurred during environment configuration.'}
                        </p>
                    </div>
                )}

                {/* Live Logs Collapsible */}
                {engineState.logs && engineState.logs.length > 0 && (
                    <div className="border border-zinc-800/80 rounded-2xl overflow-hidden bg-zinc-950/60">
                        <button
                            type="button"
                            onClick={() => setShowLogs(!showLogs)}
                            className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/50 transition-colors"
                        >
                            <span className="flex items-center gap-2 font-mono">
                                <Terminal className="w-3.5 h-3.5 text-amber-400" />
                                Terminal Logs ({engineState.logs.length} entries)
                            </span>
                            {showLogs ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>

                        {showLogs && (
                            <div className="p-3 bg-black/80 font-mono text-[10px] max-h-44 overflow-y-auto space-y-1 border-t border-zinc-900 scrollbar-thin scrollbar-thumb-zinc-800">
                                {engineState.logs.slice(-50).map((log, idx) => (
                                    <div key={idx} className={`leading-relaxed opacity-90 truncate ${getLogLineColor(log)}`}>
                                        {log}
                                    </div>
                                ))}
                                <div ref={logsEndRef} />
                            </div>
                        )}
                    </div>
                )}

                {/* Action Buttons */}
                <div className="flex items-center justify-between gap-3 pt-2">
                    {/* Open Log File — always visible on desktop */}
                    <div>
                        {isDesktop && (
                            <button
                                type="button"
                                onClick={handleOpenLogFile}
                                className="px-3 py-2 rounded-xl border border-zinc-700/80 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-[11px] font-mono flex items-center gap-1.5 transition-all active:scale-95"
                                title="Open the persistent install log file in your default text editor"
                            >
                                <FileText className="w-3.5 h-3.5" />
                                Open Log File
                            </button>
                        )}
                    </div>

                    <div className="flex items-center gap-3">
                        {isError && (
                            <>
                                <button
                                    type="button"
                                    onClick={onRepair}
                                    className="px-4 py-2.5 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center gap-2 transition-all active:scale-95"
                                >
                                    <Wrench className="w-3.5 h-3.5" />
                                    Rebuild Runtime
                                </button>
                                <button
                                    type="button"
                                    onClick={onStartInstall}
                                    className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold flex items-center gap-2 shadow-[0_0_20px_rgba(245,158,11,0.3)] transition-all active:scale-95"
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    Retry Setup
                                </button>
                            </>
                        )}

                        {isNeedsSetup && (
                            <button
                                type="button"
                                onClick={onStartInstall}
                                className="w-full py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-black text-sm font-bold flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(245,158,11,0.35)] transition-all active:scale-[0.99]"
                            >
                                <Sparkles className="w-4 h-4" />
                                Initialize Unweave AI Engine
                            </button>
                        )}

                        {isInstalling && (
                            <div className="w-full text-center text-xs text-zinc-500 font-mono py-1">
                                Please wait while dependencies are configured...
                            </div>
                        )}

                        {isReady && onClose && (
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold transition-all active:scale-95"
                            >
                                Open Unweave Studio
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
