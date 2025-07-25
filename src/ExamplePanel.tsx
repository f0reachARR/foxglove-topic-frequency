import { Immutable, PanelExtensionContext, Topic } from "@foxglove/extension";
import {
  ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";

interface FrequencyStats {
  topic: string;
  messageCount: number;
  frequencies: number[];
  averageFrequency: number;
  medianFrequency: number;
  stdDeviation: number;
  minFrequency: number;
  maxFrequency: number;
  filteredFrequencies: number[];
  outlierCount: number;
}

interface TopicTimestamps {
  [topic: string]: Set<number>;
}

interface CachedStats {
  [topic: string]: {
    stats: FrequencyStats;
    lastUpdate: number;
    timestampCount: number;
  };
}

const MAX_TIMESTAMPS_PER_TOPIC = 1000;

interface HistogramBin {
  binStart: number;
  binEnd: number;
  count: number;
}

function TopicFrequencyPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [topics, setTopics] = useState<undefined | Immutable<Topic[]>>();
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [topicTimestamps, setTopicTimestamps] = useState<TopicTimestamps>({});
  const [outlierThreshold, setOutlierThreshold] = useState<number>(2.0);
  const [showHistogram, setShowHistogram] = useState<boolean>(false);
  const [sortBy, setSortBy] = useState<"topic" | "frequency" | "outliers">("topic");
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const statsCache = useRef<CachedStats>({});

  const removeOutliers = useCallback((frequencies: number[], threshold: number): number[] => {
    if (frequencies.length < 3) {
      return frequencies;
    }

    const sum = frequencies.reduce((acc, freq) => acc + freq, 0);
    const mean = sum / frequencies.length;
    const variance =
      frequencies.reduce((acc, freq) => acc + (freq - mean) ** 2, 0) / frequencies.length;
    const stdDev = Math.sqrt(variance);

    return frequencies.filter((freq) => Math.abs(freq - mean) <= threshold * stdDev);
  }, []);

  const calculateFrequencyStats = useCallback(
    (timestamps: number[]): Omit<FrequencyStats, "topic"> => {
      if (timestamps.length < 2) {
        return {
          messageCount: timestamps.length,
          frequencies: [],
          averageFrequency: 0,
          medianFrequency: 0,
          stdDeviation: 0,
          minFrequency: 0,
          maxFrequency: 0,
          filteredFrequencies: [],
          outlierCount: 0,
        };
      }

      const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
      const intervals: number[] = [];

      for (let i = 1; i < sortedTimestamps.length; i++) {
        const interval = sortedTimestamps[i]! - sortedTimestamps[i - 1]!;
        if (interval > 0) {
          intervals.push(1.0 / interval);
        }
      }

      if (intervals.length === 0) {
        return {
          messageCount: timestamps.length,
          frequencies: [],
          averageFrequency: 0,
          medianFrequency: 0,
          stdDeviation: 0,
          minFrequency: 0,
          maxFrequency: 0,
          filteredFrequencies: [],
          outlierCount: 0,
        };
      }

      const filteredFrequencies = removeOutliers(intervals, outlierThreshold);
      const outlierCount = intervals.length - filteredFrequencies.length;

      if (filteredFrequencies.length === 0) {
        return {
          messageCount: timestamps.length,
          frequencies: intervals,
          averageFrequency: 0,
          medianFrequency: 0,
          stdDeviation: 0,
          minFrequency: 0,
          maxFrequency: 0,
          filteredFrequencies: [],
          outlierCount,
        };
      }

      const sum = filteredFrequencies.reduce((acc, freq) => acc + freq, 0);
      const average = sum / filteredFrequencies.length;
      const sortedFiltered = [...filteredFrequencies].sort((a, b) => a - b);
      const medianIndex = Math.floor(sortedFiltered.length / 2);
      const median =
        sortedFiltered.length % 2 === 0
          ? (sortedFiltered[medianIndex - 1]! + sortedFiltered[medianIndex]!) / 2
          : sortedFiltered[medianIndex]!;

      const variance =
        filteredFrequencies.reduce((acc, freq) => acc + (freq - average) ** 2, 0) /
        filteredFrequencies.length;
      const stdDev = Math.sqrt(variance);

      return {
        messageCount: timestamps.length,
        frequencies: intervals,
        averageFrequency: average,
        medianFrequency: median,
        stdDeviation: stdDev,
        minFrequency: Math.min(...filteredFrequencies),
        maxFrequency: Math.max(...filteredFrequencies),
        filteredFrequencies,
        outlierCount,
      };
    },
    [removeOutliers, outlierThreshold],
  );

  const getCachedStats = useCallback(
    (topic: string): FrequencyStats => {
      const timestamps = topicTimestamps[topic];
      const timestampCount = timestamps?.size || 0;
      const lastUpdate = timestamps ? Math.max(...Array.from(timestamps)) : 0;

      const cached = statsCache.current[topic];
      if (cached && cached.lastUpdate === lastUpdate && cached.timestampCount === timestampCount) {
        return cached.stats;
      }

      const stats: FrequencyStats = {
        topic,
        ...calculateFrequencyStats(Array.from(timestamps || []).sort()),
      };

      statsCache.current[topic] = {
        stats,
        lastUpdate,
        timestampCount,
      };

      return stats;
    },
    [topicTimestamps, calculateFrequencyStats],
  );

  const frequencyStats = useMemo(() => {
    const stats = selectedTopics.map(getCachedStats);

    return stats.sort((a, b) => {
      switch (sortBy) {
        case "frequency":
          return b.averageFrequency - a.averageFrequency;
        case "outliers":
          return b.outlierCount - a.outlierCount;
        case "topic":
        default:
          return a.topic.localeCompare(b.topic);
      }
    });
  }, [selectedTopics, getCachedStats, sortBy]);

  const createHistogram = useCallback((frequencies: number[], bins = 20): HistogramBin[] => {
    if (frequencies.length === 0) {
      return [];
    }

    const min = Math.min(...frequencies);
    const max = Math.max(...frequencies);
    const binWidth = (max - min) / bins;

    const histogram = new Array<number>(bins).fill(0);

    frequencies.forEach((freq) => {
      const binIndex = Math.min(Math.floor((freq - min) / binWidth), bins - 1);
      histogram[binIndex] = (histogram[binIndex] ?? 0) + 1;
    });

    return histogram.map((count, index) => ({
      binStart: min + index * binWidth,
      binEnd: min + (index + 1) * binWidth,
      count,
    }));
  }, []);

  const exportToCSV = useCallback(() => {
    if (frequencyStats.length === 0) {
      return;
    }

    const headers = [
      "Topic",
      "Message Count",
      "Average Frequency (Hz)",
      "Median Frequency (Hz)",
      "Standard Deviation (Hz)",
      "Min Frequency (Hz)",
      "Max Frequency (Hz)",
      "Total Samples",
      "Filtered Samples",
      "Outlier Count",
    ];

    const csvContent = [
      headers.join(","),
      ...frequencyStats.map((stats) =>
        [
          `"${stats.topic}"`,
          stats.messageCount,
          stats.averageFrequency.toFixed(4),
          stats.medianFrequency.toFixed(4),
          stats.stdDeviation.toFixed(4),
          stats.minFrequency.toFixed(4),
          stats.maxFrequency.toFixed(4),
          stats.frequencies.length,
          stats.filteredFrequencies.length,
          stats.outlierCount,
        ].join(","),
      ),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `topic_frequency_analysis_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`,
    );
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [frequencyStats]);

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setTopics(renderState.topics);

      if (renderState.currentFrame) {
        setTopicTimestamps((prev) => {
          const updated = { ...prev };
          let hasChanges = false;

          renderState.currentFrame?.forEach((messageEvent) => {
            const topic = messageEvent.topic;
            const timestamp = messageEvent.receiveTime.sec + messageEvent.receiveTime.nsec * 1e-9;

            if (!updated[topic]) {
              updated[topic] = new Set<number>();
            }

            const prevSize = updated[topic].size;
            updated[topic].add(timestamp);

            if (updated[topic].size > prevSize) {
              hasChanges = true;

              if (updated[topic].size > MAX_TIMESTAMPS_PER_TOPIC) {
                const sortedTimestamps = Array.from(updated[topic]).sort((a, b) => b - a);
                updated[topic] = new Set(sortedTimestamps.slice(0, MAX_TIMESTAMPS_PER_TOPIC));
                delete statsCache.current[topic];
              }
            }
          });

          return hasChanges ? updated : prev;
        });
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
  }, [context]);

  useEffect(() => {
    if (topics && selectedTopics.length === 0) {
      const topicNames = topics.map((t) => t.name);
      setSelectedTopics(topicNames.slice(0, 5));
      context.subscribe(topicNames.map((name) => ({ topic: name })));
    }
  }, [topics, selectedTopics.length, context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const handleTopicSelection = useCallback(
    (topicName: string, selected: boolean) => {
      if (selected) {
        setSelectedTopics((prev) => [...prev, topicName]);
        context.subscribe([{ topic: topicName }]);
      } else {
        setSelectedTopics((prev) => prev.filter((t) => t !== topicName));
      }
    },
    [context],
  );

  const handleSelectAllTopics = useCallback(() => {
    if (!topics) {
      return;
    }
    const allTopicNames = topics.map((t) => t.name);
    setSelectedTopics(allTopicNames);
    context.subscribe(allTopicNames.map((name) => ({ topic: name })));
  }, [topics, context]);

  const handleDeselectAllTopics = useCallback(() => {
    setSelectedTopics([]);
  }, []);

  const toggleTopicExpanded = useCallback((topic: string) => {
    setExpandedTopics((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(topic)) {
        newSet.delete(topic);
      } else {
        newSet.add(topic);
      }
      return newSet;
    });
  }, []);

  return (
    <div style={{ padding: "1rem", height: "100%", overflow: "auto" }}>
      <h2>ROS Topic Frequency Analyzer</h2>

      <div
        style={{
          marginBottom: "1rem",
          display: "flex",
          gap: "1rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <label>
          Outlier Threshold (σ):
          <input
            type="number"
            value={outlierThreshold}
            onChange={(e) => {
              setOutlierThreshold(Number(e.target.value));
            }}
            step="0.1"
            min="0.5"
            max="5"
            style={{ marginLeft: "0.5rem", width: "60px" }}
          />
        </label>
        <label>
          Sort by:
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value as "topic" | "frequency" | "outliers");
            }}
            style={{ marginLeft: "0.5rem" }}
          >
            <option value="topic">Topic Name</option>
            <option value="frequency">Frequency</option>
            <option value="outliers">Outlier Count</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showHistogram}
            onChange={(e) => {
              setShowHistogram(e.target.checked);
            }}
            style={{ marginRight: "0.5rem" }}
          />
          Show Histogram
        </label>
        <button
          onClick={exportToCSV}
          disabled={frequencyStats.length === 0}
          style={{
            padding: "0.5rem 1rem",
            fontSize: "0.9rem",
            border: "1px solid #007acc",
            backgroundColor: frequencyStats.length > 0 ? "#007acc" : "#ccc",
            color: "white",
            borderRadius: "4px",
            cursor: frequencyStats.length > 0 ? "pointer" : "not-allowed",
          }}
        >
          Export CSV
        </button>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Select Topics:</h3>
          <button
            onClick={handleSelectAllTopics}
            style={{
              padding: "0.25rem 0.5rem",
              fontSize: "0.8rem",
              border: "1px solid #007acc",
              backgroundColor: "#007acc",
              color: "white",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Select All
          </button>
          <button
            onClick={handleDeselectAllTopics}
            style={{
              padding: "0.25rem 0.5rem",
              fontSize: "0.8rem",
              border: "1px solid #ccc",
              backgroundColor: "#f5f5f5",
              color: "#333",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Deselect All
          </button>
        </div>
        <div
          style={{
            maxHeight: "150px",
            overflow: "auto",
            border: "1px solid #ccc",
            padding: "0.5rem",
          }}
        >
          {(topics ?? []).map((topic) => (
            <label key={topic.name} style={{ display: "block", marginBottom: "0.25rem" }}>
              <input
                type="checkbox"
                checked={selectedTopics.includes(topic.name)}
                onChange={(e) => {
                  handleTopicSelection(topic.name, e.target.checked);
                }}
                style={{ marginRight: "0.5rem" }}
              />
              {topic.name} ({topic.schemaName})
            </label>
          ))}
        </div>
      </div>

      {frequencyStats.map((stats) => {
        const isExpanded = expandedTopics.has(stats.topic);
        return (
          <div
            key={stats.topic}
            style={{
              marginBottom: "1rem",
              border: "1px solid #ddd",
              borderRadius: "4px",
            }}
          >
            <div
              style={{
                padding: "0.75rem 1rem",
                backgroundColor: "#f8f9fa",
                borderBottom: isExpanded ? "1px solid #ddd" : "none",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
              onClick={() => toggleTopicExpanded(stats.topic)}
            >
              <div>
                <strong>{stats.topic}</strong>
                <span style={{ marginLeft: "1rem", color: "#666", fontSize: "0.9em" }}>
                  {stats.messageCount} msgs | {stats.averageFrequency.toFixed(1)} Hz avg
                  {stats.outlierCount > 0 && ` | ${stats.outlierCount} outliers`}
                </span>
              </div>
              <span style={{ fontSize: "1.2em", color: "#666" }}>{isExpanded ? "▼" : "▶"}</span>
            </div>

            {isExpanded && (
              <div style={{ padding: "1rem" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: "1rem",
                    marginBottom: "1rem",
                  }}
                >
                  <div>
                    <strong>Messages:</strong> {stats.messageCount}
                    <br />
                    <strong>Avg Freq:</strong> {stats.averageFrequency.toFixed(2)} Hz
                    <br />
                    <strong>Median Freq:</strong> {stats.medianFrequency.toFixed(2)} Hz
                  </div>
                  <div>
                    <strong>Std Dev:</strong> {stats.stdDeviation.toFixed(2)} Hz
                    <br />
                    <strong>Min Freq:</strong> {stats.minFrequency.toFixed(2)} Hz
                    <br />
                    <strong>Max Freq:</strong> {stats.maxFrequency.toFixed(2)} Hz
                  </div>
                  <div>
                    <strong>Total Samples:</strong> {stats.frequencies.length}
                    <br />
                    <strong>Filtered Samples:</strong> {stats.filteredFrequencies.length}
                    <br />
                    <strong>Outliers:</strong> {stats.outlierCount}
                  </div>
                </div>

                {showHistogram && stats.filteredFrequencies.length > 0 && (
                  <div>
                    <h4>Frequency Distribution (Outliers Removed)</h4>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "end",
                        height: "120px",
                        gap: "2px",
                        position: "relative",
                      }}
                    >
                      {createHistogram(stats.filteredFrequencies).map((bin, index) => {
                        const histogramData = createHistogram(stats.filteredFrequencies);
                        const maxCount = Math.max(...histogramData.map((b) => b.count), 1);
                        const barHeight = (bin.count / maxCount) * 100;
                        return (
                          <div
                            key={index}
                            style={{
                              flex: 1,
                              backgroundColor: "#4CAF50",
                              height: `${barHeight}%`,
                              minHeight: bin.count > 0 ? "2px" : "0px",
                              position: "relative",
                              display: "flex",
                              alignItems: "flex-start",
                              justifyContent: "center",
                            }}
                            title={`${bin.binStart.toFixed(1)}-${bin.binEnd.toFixed(1)} Hz: ${bin.count} samples`}
                          >
                            {bin.count > 0 && barHeight > 15 && (
                              <span
                                style={{
                                  fontSize: "0.7em",
                                  color: "white",
                                  fontWeight: "bold",
                                  textShadow: "1px 1px 1px rgba(0,0,0,0.7)",
                                  paddingTop: "2px",
                                  lineHeight: "1",
                                }}
                              >
                                {bin.count}
                              </span>
                            )}
                            {bin.count > 0 && barHeight <= 15 && (
                              <span
                                style={{
                                  fontSize: "0.6em",
                                  color: "#333",
                                  position: "absolute",
                                  top: "-15px",
                                  fontWeight: "bold",
                                }}
                              >
                                {bin.count}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: "0.8em", marginTop: "0.25rem" }}>
                      {stats.filteredFrequencies.length > 0 &&
                        `${Math.min(...stats.filteredFrequencies).toFixed(1)} Hz - ${Math.max(...stats.filteredFrequencies).toFixed(1)} Hz`}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function initExamplePanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<TopicFrequencyPanel context={context} />);

  return () => {
    root.unmount();
  };
}
