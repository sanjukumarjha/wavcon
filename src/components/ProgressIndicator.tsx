import React from 'react';
import { AudioWaveform as Waveform } from 'lucide-react';

interface ProgressIndicatorProps {
  progress: number;
  platform: string;
}

const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({ progress, platform }) => {
  const getProgressStage = (progress: number) => {
    if (progress < 30) return 'Preparing your audio...';
    if (progress < 70) return 'Converting to .wav (48000Hz)...';
    return 'Finalizing conversion...';
  };

  return (
    <div className="text-center space-y-6">
      {/* Animated Icon */}
      <div className="relative">
        <div className={`w-20 h-20 mx-auto rounded-full flex items-center justify-center ${
          platform === 'youtube' ? 'bg-red-600/20' : 'bg-green-500/20'
        }`}>
          <Waveform className={`w-10 h-10 ${
            platform === 'youtube' ? 'text-red-400' : 'text-green-400'
          } animate-pulse`} />
        </div>
        <div className={`absolute inset-0 w-20 h-20 mx-auto rounded-full border-4 border-transparent ${
          platform === 'youtube' 
            ? 'border-t-red-600 border-r-red-600' 
            : 'border-t-green-500 border-r-green-500'
        } animate-spin`}></div>
      </div>

      {/* Progress Bar */}
      <div className="max-w-md mx-auto">
        <div className="flex justify-between items-center mb-2">
          <span className={`text-sm font-medium ${
            platform === 'youtube' ? 'text-gray-300' : 'text-gray-300'
          }`}>
            {getProgressStage(progress)}
          </span>
          <span className={`text-sm font-mono ${
            platform === 'youtube' ? 'text-red-400' : 'text-green-400'
          }`}>
            {Math.round(progress)}%
          </span>
        </div>
        
        <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
          <div 
            className={`h-full transition-all duration-300 ease-out rounded-full ${
              platform === 'youtube' 
                ? 'bg-gradient-to-r from-red-600 to-red-500' 
                : 'bg-gradient-to-r from-green-500 to-green-400'
            }`}
            style={{ width: `${progress}%` }}
          ></div>
        </div>
      </div>

      {/* Processing Details */}
      <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700 max-w-md mx-auto">
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <span className="text-gray-400">Sample Rate:</span>
            <span className="text-white ml-2 font-mono">48000Hz</span>
          </div>
          <div>
            <span className="text-gray-400">Bit Depth:</span>
            <span className="text-white ml-2 font-mono">16-bit</span>
          </div>
          <div>
            <span className="text-gray-400">Channels:</span>
            <span className="text-white ml-2 font-mono">Stereo</span>
          </div>
          <div>
            <span className="text-gray-400">Format:</span>
            <span className="text-white ml-2 font-mono">WAV</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProgressIndicator;