import React, { useState, useRef } from 'react';
import { Play, RotateCcw, Music, CheckCircle, Download, Youtube, Podcast } from 'lucide-react';

// --- TYPE DEFINITIONS ---
type Platform = 'default' | 'youtube' | 'spotify';
type AppState = 'input' | 'loading' | 'ready' | 'processing' | 'complete';
interface MediaData {
  title: string;
  subtitle: string;
  thumbnail: string;
  platform: Platform;
  poster?: string | null;
}

// --- COMPONENT: UrlInput ---
const UrlInput = ({ onUrlSubmit }: { onUrlSubmit: (url: string) => void }) => {
    const [url, setUrl] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (url.trim()) {
            onUrlSubmit(url.trim());
        }
    };
    
    return (
        <form onSubmit={handleSubmit} className="relative">
            <input
                ref={inputRef}
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste YouTube or Spotify URL here..."
                className="w-full pl-6 pr-28 py-4 text-lg bg-white/80 backdrop-blur-sm border-2 border-gray-200 rounded-full focus:ring-4 focus:ring-blue-300 focus:border-blue-500 transition-all duration-300"
            />
            <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 px-6 py-2.5 bg-blue-500 text-white font-semibold rounded-full hover:bg-blue-600 transition-all transform hover:scale-105 active:scale-95">
                Go
            </button>
        </form>
    );
};

// --- COMPONENT: MediaCard ---
const MediaCard = ({ mediaData, platform, onImageDownload }: { mediaData: MediaData, platform: Platform, onImageDownload: (url: string, title: string, type: 'thumbnail' | 'poster') => void }) => (
    <div className={`rounded-2xl p-6 shadow-xl transition-all duration-500 ${platform === 'spotify' ? 'bg-zinc-800' : 'bg-zinc-800'}`}>
        <div className="flex flex-col md:flex-row gap-6">
            <img 
                src={mediaData.thumbnail} 
                alt={mediaData.title} 
                className="w-full md:w-40 h-40 object-cover rounded-lg shadow-md cursor-pointer"
                onClick={() => onImageDownload(mediaData.thumbnail, mediaData.title, 'thumbnail')}
            />
            <div className="flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2 text-sm text-gray-400">
                    {platform === 'youtube' ? <Youtube size={16} /> : <Podcast size={16} />}
                    <span>{platform.charAt(0).toUpperCase() + platform.slice(1)}</span>
                </div>
                <h2 className="text-2xl font-bold text-white">{mediaData.title}</h2>
                <p className="text-lg text-gray-300">{mediaData.subtitle}</p>
            </div>
        </div>
    </div>
);

// --- COMPONENT: ProgressIndicator ---
const ProgressIndicator = ({ progress, platform }: { progress: number, platform: Platform }) => (
    <div className="text-center space-y-4">
        <p className="text-lg font-medium text-gray-300">Processing... Please wait.</p>
        <div className="w-full bg-gray-700 rounded-full h-4 overflow-hidden">
            <div
                className={`h-4 rounded-full transition-all duration-500 ease-out ${platform === 'youtube' ? 'bg-red-600' : 'bg-green-500'}`}
                style={{ width: `${progress}%` }}
            ></div>
        </div>
    </div>
);

// --- COMPONENT: MediaCardSkeleton ---
const MediaCardSkeleton = ({ platform }: { platform: Platform }) => (
    <div className={`rounded-2xl p-6 shadow-xl animate-pulse ${platform === 'spotify' ? 'bg-zinc-800' : 'bg-zinc-800'}`}>
        <div className="flex flex-col md:flex-row gap-6">
            <div className="w-full md:w-40 h-40 bg-gray-700 rounded-lg"></div>
            <div className="flex-1 space-y-4 py-1">
                <div className="h-4 bg-gray-700 rounded w-1/4"></div>
                <div className="h-8 bg-gray-600 rounded w-3/4"></div>
                <div className="h-6 bg-gray-700 rounded w-1/2"></div>
            </div>
        </div>
    </div>
);


// --- MAIN APP COMPONENT ---
function App() {
    const [currentPlatform, setCurrentPlatform] = useState<Platform>('default');
    const [appState, setAppState] = useState<AppState>('input');
    const [mediaData, setMediaData] = useState<MediaData | null>(null);
    const [progress, setProgress] = useState(0);
    const [urlToConvert, setUrlToConvert] = useState<string>('');
    const [error, setError] = useState<string | null>(null);

    const detectPlatform = (url: string): Platform => {
        if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
        if (url.includes('spotify.com')) return 'spotify';
        return 'default';
    };

    const handleUrlSubmit = async (url: string) => {
        setUrlToConvert(url);
        setError(null);
        setAppState('loading');
        setCurrentPlatform(detectPlatform(url));

        try {
            const response = await fetch(`${import.meta.env.VITE_API_URL}/api/get-media-data`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to fetch media data.');
            }
            const data: MediaData = await response.json();
            setMediaData(data);
            setCurrentPlatform(data.platform);
            setAppState('ready');
        } catch (err: any) {
            console.error('Error fetching media data:', err);
            setError(err.message);
            setAppState('input');
        }
    };

    const handleDownload = async () => {
        if (!urlToConvert || !mediaData) return;
        setAppState('processing');
        setProgress(0);
        setError(null);

        const prepInterval = setInterval(() => {
            setProgress(prev => (prev >= 95 ? 95 : prev + Math.random() * 5));
        }, 400);

        try {
            const response = await fetch(`${import.meta.env.VITE_API_URL}/api/convert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlToConvert, title: mediaData.title }),
            });

            clearInterval(prepInterval);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || 'Download failed.');
            }
            setProgress(100);
            setAppState('complete');
            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = `${mediaData.title.replace(/[^a-z0-9_-\s]/gi, '_').trim()}.wav`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(downloadUrl);
        } catch (err: any) {
            clearInterval(prepInterval);
            console.error('An unexpected error occurred:', err);
            setError(err.message || 'An unexpected error occurred.');
            setAppState('ready');
        }
    };

    const handleImageDownload = (imageUrl: string, title: string, type: 'thumbnail' | 'poster') => {
        const serverUrl = `${import.meta.env.VITE_API_URL}/api/download-image`;
        const downloadUrl = `${serverUrl}?url=${encodeURIComponent(imageUrl)}&title=${encodeURIComponent(title)}&type=${type}`;
        window.open(downloadUrl, '_blank');
    };

    const handleReset = () => {
        setCurrentPlatform('default');
        setAppState('input');
        setMediaData(null);
        setProgress(0);
        setUrlToConvert('');
        setError(null);
    };

    const getThemeClasses = () => {
        switch (currentPlatform) {
            case 'youtube': return 'bg-[#0f0f0f] text-white font-roboto';
            case 'spotify': return 'bg-[#121212] text-white font-sans';
            default: return 'bg-gradient-to-br from-slate-50 to-slate-100 text-gray-800';
        }
    };

    return (
        <div className={`min-h-screen transition-all duration-700 ease-in-out ${getThemeClasses()}`}>
            <div className="container mx-auto px-4 py-8 md:py-16">
                <header className="text-center mb-12">
                     <div className="flex items-center justify-center mb-6">
                        <div className={`p-3 rounded-2xl transition-all duration-500 ${currentPlatform === 'youtube' ? 'bg-red-600' : currentPlatform === 'spotify' ? 'bg-green-500' : 'bg-blue-500'}`}>
                            <Music className="h-8 w-8 text-white" />
                        </div>
                    </div>
                    <h1 className={`text-4xl md:text-5xl font-bold mb-4 ${currentPlatform !== 'default' ? 'text-white' : 'text-gray-800'}`}>WavCon</h1>
                    <p className={`text-xl md:text-2xl ${currentPlatform !== 'default' ? 'text-gray-300' : 'text-gray-600'}`}>Paste a Link, Get High-Quality Audio</p>
                </header>

                <div className="max-w-2xl mx-auto">
                    {appState === 'input' && (
                        <>
                            <UrlInput onUrlSubmit={handleUrlSubmit} />
                            {error && <div className="mt-4 text-center text-red-500 bg-red-500/10 p-3 rounded-lg"><strong>Error:</strong> {error}</div>}
                        </>
                    )}

                    {appState === 'loading' && <MediaCardSkeleton platform={currentPlatform} />}

                    {(appState === 'ready' || appState === 'processing' || appState === 'complete') && mediaData && (
                        <div className="space-y-8">
                            <MediaCard mediaData={mediaData} platform={currentPlatform} onImageDownload={handleImageDownload} />
                            {error && <div className="mt-4 text-center text-red-500 bg-red-500/10 p-3 rounded-lg"><strong>Error:</strong> {error}</div>}

                            {appState === 'ready' && (
                                <div className="text-center space-y-4">
                                    <button onClick={handleDownload} className={`px-8 py-4 rounded-full font-semibold text-lg transition-all duration-300 transform hover:scale-105 active:scale-95 ${currentPlatform === 'youtube' ? 'bg-red-600 hover:bg-red-700 text-white shadow-lg' : 'bg-green-500 hover:bg-green-600 text-white shadow-lg'}`}>
                                        <Play className="inline-block w-5 h-5 mr-2" /> Convert to .wav
                                    </button>
                                    <div className="flex justify-center gap-4 mt-4">
                                        {currentPlatform === 'spotify' && mediaData.poster && (
                                            <button onClick={() => handleImageDownload(mediaData.poster!, mediaData.title, 'poster')} className="flex items-center px-6 py-3 bg-purple-600 text-white rounded-full hover:bg-purple-700 transition-all">
                                                <Download className="w-4 h-4 mr-2" /> Download Poster
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {appState === 'processing' && <ProgressIndicator progress={progress} platform={currentPlatform} />}

                            {appState === 'complete' && (
                                <div className="text-center space-y-6">
                                    <div className="inline-flex items-center justify-center px-6 py-3 rounded-full text-green-400 bg-green-500/20">
                                        <CheckCircle className="w-5 h-5 mr-3" />
                                        <span className="font-semibold">Your download has started!</span>
                                    </div>
                                    <button onClick={handleReset} className={`flex items-center mx-auto px-6 py-3 rounded-full transition-all duration-300 hover:scale-105 ${currentPlatform !== 'default' ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-400'}`}>
                                        <RotateCcw className="w-4 h-4 mr-2" /> Convert Another
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                 <footer className={`text-center mt-16 pt-8 border-t transition-all duration-500 ${currentPlatform === 'default' ? 'border-gray-200' : 'border-gray-700'}`}>
                    <p className={`text-sm ${currentPlatform === 'default' ? 'text-gray-500' : 'text-gray-400'}`}>High-quality audio conversion at 48000Hz • Supports YouTube & Spotify</p>
                </footer>
            </div>
        </div>
    );
}

export default App;
