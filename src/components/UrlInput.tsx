import React, { useState } from 'react';
import { Link as LinkIcon } from 'lucide-react';

interface UrlInputProps {
  onUrlSubmit: (url: string) => void;
}

const UrlInput: React.FC<UrlInputProps> = ({ onUrlSubmit }) => {
  const [url, setUrl] = useState('');
  const [isValidUrl, setIsValidUrl] = useState(false);

  const validateUrl = (inputUrl: string) => {
    const isValid = inputUrl.includes('youtube.com') ||
                   inputUrl.includes('youtu.be') ||
                   inputUrl.includes('spotify.com');
    setIsValidUrl(isValid);
    return isValid;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputUrl = e.target.value;
    setUrl(inputUrl);
    validateUrl(inputUrl);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isValidUrl) {
      onUrlSubmit(url);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUrl(text);
      if (validateUrl(text)) {
        onUrlSubmit(text);
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
          <LinkIcon className="h-6 w-6 text-gray-400" />
        </div>
        <input
          type="text"
          value={url}
          onChange={handleInputChange}
          placeholder="Paste your YouTube or Spotify link here..."
          className={`w-full pl-12 pr-4 py-4 text-lg bg-white border-2 rounded-2xl shadow-lg focus:outline-none focus:ring-4 transition-all duration-300 ${
            url && !isValidUrl
              ? 'border-red-300 focus:border-red-500 focus:ring-red-100'
              : 'border-gray-200 focus:border-blue-500 focus:ring-blue-100'
          }`}
        />
        {url && !isValidUrl && (
          <p className="mt-2 text-sm text-red-600 flex items-center">
            Please enter a valid YouTube or Spotify URL
          </p>
        )}
      </div>

      <div className="text-center space-y-4">
        <button
          type="submit"
          disabled={!isValidUrl}
          className={`px-8 py-4 rounded-full font-semibold text-lg transition-all duration-300 transform ${
            isValidUrl
              ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg hover:shadow-xl hover:scale-105 active:scale-95'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          Get Media Info
        </button>

        <div className="text-gray-500 text-sm">
          or{' '}
          <button
            type="button"
            onClick={handlePaste}
            className="text-blue-600 hover:text-blue-700 underline font-medium"
          >
            paste from clipboard
          </button>
        </div>
      </div>
    </form>
  );
};

export default UrlInput;