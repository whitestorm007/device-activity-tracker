import React, { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Square, Activity, Wifi, Smartphone, Monitor, MessageCircle, BarChart2, ShieldCheck, Zap, Clock } from 'lucide-react';
import clsx from 'clsx';
import { socket } from '../App';

type Platform = 'whatsapp' | 'signal';

interface TrackerData {
    rtt: number;
    avg: number;
    onlineAvg: number;
    standbyAvg: number;
    threshold: number;
    confidence: number;
    state: string;
    timestamp: number;
}

interface DeviceInfo {
    jid: string;
    state: string;
    rtt: number;
    avg: number;
}

interface ContactCardProps {
    jid: string;
    displayNumber: string;
    data: TrackerData[];
    devices: DeviceInfo[];
    deviceCount: number;
    presence: string | null;
    profilePic: string | null;
    onRemove: () => void;
    privacyMode?: boolean;
    platform?: Platform;
}

interface HeatmapHour {
    hourStr: number; // MS timestamp of the hour start
    total_samples: number;
    online_samples: number;
}

export function ContactCard({
    jid,
    displayNumber,
    data,
    devices,
    deviceCount,
    presence,
    profilePic,
    onRemove,
    privacyMode = false,
    platform = 'whatsapp'
}: ContactCardProps) {
    const [history, setHistory] = useState<HeatmapHour[]>([]);
    const lastData = data[data.length - 1];

    // Fetch history using simple fetch API since we added the endpoint
    // We re-fetch every minute to keep it updated
    useEffect(() => {
        const fetchHistory = async () => {
            try {
                // Use default localhost port from env or 3001
                const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:3001';
                const res = await fetch(`${apiUrl}/api/history/${jid}`);
                if (res.ok) {
                    const json = await res.json();
                    setHistory(json);
                }
            } catch (err) {
                console.error('Failed to load history', err);
            }
        };

        fetchHistory();
        const interval = setInterval(fetchHistory, 60000);
        return () => clearInterval(interval);
    }, [jid]);

    const currentStatus = devices.length > 0
        ? (devices.find(d => d.state === 'OFFLINE')?.state ||
            devices.find(d => d.state.includes('Online'))?.state ||
            devices[0].state)
        : 'Unknown';

    const blurredNumber = privacyMode ? displayNumber.replace(/\d/g, '•') : displayNumber;
    const confidencePct = lastData?.confidence ? Math.round(lastData.confidence * 100) : 0;
    const confidenceColor = confidencePct > 80 ? 'text-green-600' : confidencePct > 50 ? 'text-yellow-600' : 'text-red-500';

    // Process history into 24-hour bins (Pattern of Life)
    // We aggregate all days into a single "Average Day" view for simplicity
    const hourlyActivity = new Array(24).fill(0).map(() => ({ total: 0, online: 0 }));

    history.forEach(h => {
        const hour = new Date(h.hourStr).getHours();
        hourlyActivity[hour].total += h.total_samples;
        hourlyActivity[hour].online += h.online_samples;
    });

    return (
        <div className="bg-gradient-to-br from-white to-gray-50 rounded-xl shadow-lg border border-gray-200 overflow-hidden">
            {/* Header */}
            <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <span className={clsx(
                        "px-2 py-1 rounded text-xs font-medium flex items-center gap-1",
                        platform === 'whatsapp' ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                    )}>
                        <MessageCircle size={12} />
                        {platform === 'whatsapp' ? 'WhatsApp' : 'Signal'}
                    </span>
                    <h3 className="text-lg font-semibold text-gray-900">{blurredNumber}</h3>
                </div>
                <button onClick={onRemove} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2 font-medium transition-colors text-sm">
                    <Square size={16} /> Stop
                </button>
            </div>

            <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Status Card */}
                    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex flex-col items-center text-center">
                        <div className="relative mb-4">
                            <div className="w-32 h-32 rounded-full overflow-hidden bg-gray-100 border-4 border-white shadow-md">
                                {profilePic ? (
                                    <img src={profilePic} alt="Profile" className={clsx("w-full h-full object-cover", privacyMode && "blur-xl scale-110")} />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-400">No Image</div>
                                )}
                            </div>
                            <div className={clsx("absolute bottom-2 right-2 w-6 h-6 rounded-full border-2 border-white",
                                currentStatus === 'OFFLINE' ? "bg-red-500" : currentStatus.includes('Online') ? "bg-green-500" : "bg-gray-400")} />
                        </div>

                        <h4 className="text-xl font-bold text-gray-900 mb-1">{blurredNumber}</h4>

                        <div className="flex items-center gap-2 mb-4">
                            <span className={clsx("px-3 py-1 rounded-full text-sm font-medium",
                                currentStatus === 'OFFLINE' ? "bg-red-100 text-red-700" :
                                    currentStatus.includes('Online') ? "bg-green-100 text-green-700" :
                                        currentStatus === 'Standby' ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-700")}>
                                {currentStatus}
                            </span>
                        </div>

                        <div className="w-full pt-4 border-t border-gray-100 space-y-2">
                            <div className="flex justify-between items-center text-sm text-gray-600">
                                <span className="flex items-center gap-1"><Wifi size={16} /> Official Status</span>
                                <span className="font-medium">{presence || 'Unknown'}</span>
                            </div>
                            <div className="flex justify-between items-center text-sm text-gray-600">
                                <span className="flex items-center gap-1"><Smartphone size={16} /> Devices</span>
                                <span className="font-medium">{deviceCount || 0}</span>
                            </div>
                            {lastData?.confidence !== undefined && (
                                <div className="flex justify-between items-center text-sm text-gray-600">
                                    <span className="flex items-center gap-1"><ShieldCheck size={16} /> Confidence</span>
                                    <span className={clsx("font-bold", confidenceColor)}>{confidencePct}%</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Metrics & Chart */}
                    <div className="md:col-span-2 space-y-6">
                        {/* Metrics Grid */}
                        <div className="grid grid-cols-3 gap-4">
                            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                                <div className="text-sm text-gray-500 mb-1 flex items-center gap-1"><Activity size={16} /> Current RTT</div>
                                <div className="text-2xl font-bold text-gray-900">{lastData?.rtt || '-'} <span className="text-sm text-gray-500 font-normal">ms</span></div>
                            </div>
                            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                                <div className="text-sm text-gray-500 mb-1 flex items-center gap-1"><BarChart2 size={16} /> Clusters</div>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-lg font-bold text-green-600">{lastData?.onlineAvg?.toFixed(0) || '-'}</span>
                                    <span className="text-gray-400">/</span>
                                    <span className="text-lg font-bold text-yellow-600">{lastData?.standbyAvg?.toFixed(0) || '-'}</span>
                                </div>
                            </div>
                            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                                <div className="text-sm text-gray-500 mb-1 flex items-center gap-1"><Zap size={16} /> Threshold</div>
                                <div className="text-2xl font-bold text-blue-600">{lastData?.threshold?.toFixed(0) || '-'} <span className="text-sm text-gray-500 font-normal">ms</span></div>
                            </div>
                        </div>

                        {/* Chart */}
                        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 h-[220px]">
                            <h5 className="text-sm font-medium text-gray-500 mb-4">Real-Time Latency</h5>
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={data}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                                    <XAxis dataKey="timestamp" hide />
                                    <YAxis domain={['auto', 'auto']} />
                                    <Tooltip labelFormatter={(t: number) => new Date(t).toLocaleTimeString()} />
                                    <Line type="monotone" dataKey="rtt" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                                    <Line type="step" dataKey="threshold" stroke="#ef4444" strokeDasharray="5 5" dot={false} isAnimationActive={false} />
                                    <Line type="monotone" dataKey="onlineAvg" stroke="#22c55e" strokeOpacity={0.5} dot={false} isAnimationActive={false} />
                                    <Line type="monotone" dataKey="standbyAvg" stroke="#eab308" strokeOpacity={0.5} dot={false} isAnimationActive={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>

                        {/* Pattern of Life Heatmap */}
                        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                            <div className="flex justify-between items-center mb-4">
                                <h5 className="text-sm font-medium text-gray-500 flex items-center gap-2">
                                    <Clock size={16} /> Pattern of Life (Avg Activity by Hour)
                                </h5>
                            </div>
                            <div className="grid grid-cols-12 gap-1 md:gap-2">
                                {hourlyActivity.map((h, i) => {
                                    const pct = h.total > 0 ? (h.online / h.total) : 0;
                                    // Activity intensity levels
                                    const intensity = pct === 0 ? 'bg-gray-100' :
                                        pct < 0.2 ? 'bg-green-200' :
                                            pct < 0.5 ? 'bg-green-400' :
                                                pct < 0.8 ? 'bg-green-600' : 'bg-green-800';

                                    return (
                                        <div key={i} className="flex flex-col items-center gap-1">
                                            <div
                                                className={clsx("w-full aspect-square rounded cursor-help transition-all hover:ring-2 ring-offset-1 ring-blue-500", intensity)}
                                                title={`${i}:00 - ${Math.round(pct * 100)}% Active (${h.online}/${h.total} samples)`}
                                            />
                                            <span className="text-[10px] text-gray-400">{i}h</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
