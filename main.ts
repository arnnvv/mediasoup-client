import {
  type Transport,
  type RtpCapabilities as ClientRtpCapabilities,
  Device,
  type Producer,
  type Consumer,
  type DtlsParameters,
  type RtpParameters,
  type IceCandidate,
  type IceParameters,
  type AppData,
  type MediaKind,
} from "mediasoup-client/types";

interface RtpCapabilitiesResponse {
  rtpCapabilities: ClientRtpCapabilities;
}

interface CreateTransportResponse {
  error?: string;
  params?: {
    id: string;
    iceParameters: IceParameters;
    iceCandidates: IceCandidate[];
    dtlsParameters: DtlsParameters;
  };
}

interface ProduceResponse {
  error?: string;
  id?: string;
}

interface ConsumeResponse {
  error?: string;
  params?: {
    id: string;
    producerId: string;
    kind: "audio" | "video";
    rtpParameters: RtpParameters;
  };
}

interface NewProducerData {
  producerId: string;
  producerSocketId: string;
  kind: "audio" | "video";
}

interface ExistingProducersData {
  producers: NewProducerData[];
}

interface ProducerClosedData {
  producerId: string;
}

interface ConsumerClosedData {
  consumerId: string;
  producerId: string;
}

interface ConnectionSuccessData {
  socketId: string;
}

type WebSocketResponse =
  | RtpCapabilitiesResponse
  | CreateTransportResponse
  | ProduceResponse
  | ConsumeResponse;

let socket: WebSocket;
let socketId: string;
let device: Device;
let clientRtpCapabilities: ClientRtpCapabilities;
let producerTransport: Transport<AppData> | null = null;
let videoProducer: Producer | null = null;
let audioProducer: Producer | null = null;
let consumerTransport: Transport<AppData>;
const webRtcConsumers = new Map<string, Consumer>();
let localStream: MediaStream | null = null;
let isReadyToConsume = false;
let pendingConsumes: string[] = [];
const pendingRequests = new Map<string, (value: WebSocketResponse) => void>();

const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
const btnStartStreaming = document.getElementById(
  "btnStartStreaming",
) as HTMLButtonElement;

const videoParams = {
  encodings: [
    {
      rid: "r0",
      maxBitrate: 100000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r1",
      maxBitrate: 300000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r2",
      maxBitrate: 900000,
      scalabilityMode: "S1T3",
    },
  ],
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

let remoteStream: MediaStream | null = null;

const send = (event: string, data: object = {}) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event, data }));
  }
};

const request = (event: string, data: object = {}) => {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    pendingRequests.set(requestId, resolve);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ event, data, requestId }));
    }
  });
};

async function waitForTransportConnection(transport: Transport): Promise<void> {
  return new Promise((resolve) => {
    if (transport.connectionState === "connected") {
      resolve();
      return;
    }

    const onStateChange = (state: string) => {
      if (state === "connected") {
        transport.off("connectionstatechange", onStateChange);
        resolve();
      }
    };

    transport.on("connectionstatechange", onStateChange);

    setTimeout(() => {
      transport.off("connectionstatechange", onStateChange);
      resolve();
    }, 5000);
  });
}

async function initSocket() {
  return new Promise<void>((resolve, reject) => {
    socket = new WebSocket("wss://localhost:3000/mediasoup");

    socket.onopen = () => {
      console.log("CLIENT: WebSocket connection opened.");
      resolve();
    };

    socket.onerror = (event) => {
      console.error(`CLIENT: WebSocket connection error: ${event}`);
      alert("Failed to connect to signaling server.");
      btnStartStreaming.disabled = true;
      reject(event);
    };

    socket.onclose = () => {
      console.warn("CLIENT: Disconnected from signaling server");
      cleanupLocalResources();
    };

    socket.onmessage = async (message) => {
      const { event, data, requestId } = JSON.parse(message.data);

      if (requestId && pendingRequests.has(requestId)) {
        const resolve = pendingRequests.get(requestId);
        if (resolve) {
          resolve(data);
          pendingRequests.delete(requestId);
        }
        return;
      }

      switch (event) {
        case "connection-success":
          {
            const { socketId: newId } = data as ConnectionSuccessData;
            socketId = newId;
            console.log(
              `CLIENT (${socketId}): Connected to Mediasoup server. My socket ID: ${newId}`,
            );
          }
          break;
        case "new-producer":
          {
            const producerData = data as NewProducerData;
            console.log(
              `CLIENT (${socketId}): Event 'new-producer' received for P2P WebRTC: ${producerData}`,
            );
            if (producerData.producerSocketId === socketId) {
              return;
            }
            if (!webRtcConsumers.has(producerData.producerId)) {
              if (isReadyToConsume) {
                await consumeWebRtcStream(producerData.producerId);
              } else {
                pendingConsumes.push(producerData.producerId);
              }
            }
          }
          break;
        case "producer-closed":
          {
            const { producerId } = data as ProducerClosedData;
            console.log(
              `CLIENT (${socketId}): Event 'producer-closed' received for P2P WebRTC. Producer ${producerId} closed on server.`,
            );
            const consumer = webRtcConsumers.get(producerId);
            if (consumer) {
              handleWebRtcConsumerClosed(consumer);
              webRtcConsumers.delete(producerId);
            }
          }
          break;
        case "existing-producers":
          {
            const { producers } = data as ExistingProducersData;
            console.log(
              `CLIENT (${socketId}): Received 'existing-producers' ${producers}`,
            );
            for (const producerInfo of producers) {
              if (producerInfo.producerSocketId === socketId) {
                continue;
              }
              if (!webRtcConsumers.has(producerInfo.producerId)) {
                if (isReadyToConsume) {
                  await consumeWebRtcStream(producerInfo.producerId);
                } else {
                  pendingConsumes.push(producerInfo.producerId);
                }
              }
            }
          }
          break;
        case "consumer-closed":
          {
            const { consumerId, producerId } = data as ConsumerClosedData;
            console.log(
              `CLIENT (${socketId}): Event 'consumer-closed' for P2P WebRTC. My consumer ${consumerId} (for P ${producerId}) closed by server.`,
            );
            const consumer = Array.from(webRtcConsumers.values()).find(
              (c) => c.id === consumerId,
            );
            if (consumer) {
              handleWebRtcConsumerClosed(consumer);
              webRtcConsumers.delete(consumer.producerId);
            }
          }
          break;
      }
    };
  });
}

function handleWebRtcConsumerClosed(consumer: Consumer) {
  if (remoteStream?.getTracks().some((t) => t.id === consumer.track.id)) {
    remoteStream.removeTrack(consumer.track);
    if (remoteStream.getTracks().length === 0) {
      remoteVideo.srcObject = null;
      remoteStream = null;
    }
  }
  if (!consumer.closed) consumer.close();
}

function cleanupLocalResources() {
  isReadyToConsume = false;
  pendingConsumes = [];

  if (videoProducer && !videoProducer.closed) videoProducer.close();
  if (audioProducer && !audioProducer.closed) audioProducer.close();
  if (producerTransport && !producerTransport.closed) producerTransport.close();

  for (const [_, c] of webRtcConsumers) {
    if (!c.closed) c.close();
  }
  if (consumerTransport && !consumerTransport.closed) consumerTransport.close();

  videoProducer = null;
  audioProducer = null;
  producerTransport = null;
  webRtcConsumers.clear();

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
    localStream = null;
    localVideo.srcObject = null;
  }

  remoteVideo.srcObject = null;
  remoteStream = null;

  btnStartStreaming.textContent = "Start Streaming";
  btnStartStreaming.disabled = false;
}

async function getLocalVideo(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: {
          ideal: 640,
        },
        height: {
          ideal: 480,
        },
      },
    });
    localVideo.srcObject = stream;
    localStream = stream;
    return stream;
  } catch (error) {
    console.error(`CLIENT (${socketId}): Error getting local media: ${error}`);
    alert("Could not access camera/microphone. Check permissions.");
    return null;
  }
}

async function loadDevice() {
  if (device?.loaded) {
    return;
  }
  try {
    const data = (await request(
      "getRtpCapabilities",
    )) as RtpCapabilitiesResponse;
    if (!data || !data.rtpCapabilities) {
      throw new Error("No RTP capabilities from server.");
    }
    clientRtpCapabilities = data.rtpCapabilities;

    device = new Device();
    await device.load({ routerRtpCapabilities: clientRtpCapabilities });
  } catch (error) {
    console.error(
      `CLIENT (${socketId}): Error loading Mediasoup device: ${error}`,
    );
    if ((error as Error).name === "UnsupportedError")
      alert("Browser not supported.");
    throw error;
  }
}

async function createSendTransport() {
  const response = (await request("createWebRtcTransport", {
    sender: true,
  })) as CreateTransportResponse;

  if (response.error || !response.params) {
    throw new Error(response.error);
  }

  producerTransport = device.createSendTransport({
    ...response.params,
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302",
      },
      {
        urls: "stun:stun1.l.google.com:19302",
      },
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: "turn:openrelay.metered.ca:443",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ],
    iceTransportPolicy: "all",
  });

  producerTransport.on(
    "connect",
    async (
      { dtlsParameters }: { dtlsParameters: DtlsParameters },
      callback: () => void,
      errback: (e: Error) => void,
    ) => {
      try {
        send("transport-connect", {
          transportId: producerTransport?.id,
          dtlsParameters,
        });
        callback();
      } catch (error) {
        errback(error as Error);
      }
    },
  );

  producerTransport.on(
    "produce",
    async (
      {
        kind,
        rtpParameters,
        appData,
      }: {
        kind: MediaKind;
        rtpParameters: RtpParameters;
        appData: AppData;
      },
      callback: ({ id }: { id: string }) => void,
      errback: (e: Error) => void,
    ) => {
      try {
        const response = (await request("transport-produce", {
          transportId: producerTransport?.id,
          kind,
          rtpParameters,
          appData,
        })) as ProduceResponse;

        if (response.error || !response.id) {
          throw new Error(response.error);
        }
        callback({ id: response.id });
      } catch (error) {
        errback(error as Error);
      }
    },
  );
}

async function createRecvTransport() {
  const response = (await request("createWebRtcTransport", {
    sender: false,
  })) as CreateTransportResponse;

  if (response.error || !response.params) {
    throw new Error(response.error);
  }

  consumerTransport = device.createRecvTransport({
    ...response.params,
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302",
      },
      {
        urls: "stun:stun1.l.google.com:19302",
      },
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: "turn:openrelay.metered.ca:443",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ],
    iceTransportPolicy: "all",
  });
  consumerTransport.on(
    "connect",
    async (
      { dtlsParameters }: { dtlsParameters: DtlsParameters },
      callback: () => void,
      errback: (e: Error) => void,
    ) => {
      try {
        send("transport-connect", {
          transportId: consumerTransport?.id,
          dtlsParameters,
        });
        callback();
      } catch (error) {
        errback(error as Error);
      }
    },
  );
}

async function startProducingVideo() {
  if (!localStream || !producerTransport) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) {
    return;
  }
  try {
    videoProducer = await producerTransport.produce({
      track: videoTrack,
      ...videoParams,
      appData: { mediaTag: "cam-video" },
    });
    videoProducer.on("trackended", () => {
      stopStreamingFlow();
    });
    videoProducer.on("transportclose", () => {
      videoProducer = null;
    });
  } catch (error) {
    console.error(`CLIENT (${socketId}): Error producing video: ${error}`);
  }
}

async function startProducingAudio() {
  if (!localStream || !producerTransport) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) {
    return;
  }
  try {
    audioProducer = await producerTransport.produce({
      track: audioTrack,
      appData: { mediaTag: "mic-audio" },
    });
    audioProducer.on("trackended", () => {});
    audioProducer.on("transportclose", () => {
      audioProducer = null;
    });
  } catch (error) {
    console.error(`CLIENT (${socketId}): Error producing audio: ${error}`);
  }
}

async function consumeWebRtcStream(producerIdToConsume: string) {
  if (!device || !device.loaded) {
    try {
      await loadDevice();
    } catch (_e) {
      return;
    }
  }

  if (!consumerTransport || consumerTransport.closed) {
    try {
      await createRecvTransport();
      if (!consumerTransport || consumerTransport.closed) {
        return;
      }
    } catch (_err) {
      return;
    }
  }

  if (!device.rtpCapabilities) {
    return;
  }

  if (webRtcConsumers.has(producerIdToConsume)) {
    return;
  }

  try {
    const data = (await request("consume", {
      consumerTransportId: consumerTransport.id,
      producerId: producerIdToConsume,
      rtpCapabilities: device.rtpCapabilities,
    })) as ConsumeResponse;

    if (data.error || !data.params) {
      throw new Error(data.error);
    }

    const consumer = await consumerTransport.consume({
      id: data.params.id,
      producerId: data.params.producerId,
      kind: data.params.kind,
      rtpParameters: data.params.rtpParameters,
      appData: { source: "webrtc-p2p" },
    });
    webRtcConsumers.set(consumer.producerId, consumer);

    consumer.on("transportclose", () => {
      webRtcConsumers.delete(consumer.producerId);
    });
    consumer.on("@close", () => {
      handleWebRtcConsumerClosed(consumer);
      webRtcConsumers.delete(consumer.producerId);
    });
    consumer.on("trackended", () => {
      handleWebRtcConsumerClosed(consumer);
      webRtcConsumers.delete(consumer.producerId);
    });

    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }

    remoteStream.addTrack(consumer.track);

    send("consumer-resume", { consumerId: consumer.id });
  } catch (error) {
    console.error(
      `CLIENT (${socketId}): Error consuming P2P stream for producer ${producerIdToConsume}: ${error}`,
    );
  }
}

async function startStreamingFlow() {
  btnStartStreaming.disabled = true;
  btnStartStreaming.textContent = "Starting...";
  try {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      await initSocket();
    }
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("Failed to connect to signaling server after init.");

    if (!localStream) {
      await getLocalVideo();
      if (!localStream) throw new Error("Failed to get local media.");
    }

    if (!device || !device.loaded) await loadDevice();

    if (!producerTransport || producerTransport.closed)
      await createSendTransport();

    if (!consumerTransport || consumerTransport.closed) {
      await createRecvTransport();
      await waitForTransportConnection(consumerTransport);
    }

    isReadyToConsume = true;

    for (const producerId of pendingConsumes) {
      await consumeWebRtcStream(producerId);
    }
    pendingConsumes = [];

    const producePromises = [];
    if (!videoProducer || videoProducer.closed)
      producePromises.push(startProducingVideo());
    if (!audioProducer || audioProducer.closed)
      producePromises.push(startProducingAudio());
    await Promise.all(producePromises);

    if (
      (videoProducer && !videoProducer.closed) ||
      (audioProducer && !audioProducer.closed)
    ) {
      btnStartStreaming.textContent = "Stop Streaming";
    } else {
      btnStartStreaming.textContent = "Start Streaming";
    }
  } catch (error) {
    console.error(
      `CLIENT (${socketId || "unidentified"}): Error during startStreamingFlow: ${error}`,
    );
    alert(`Could not start streaming: ${(error as Error).message}`);
    btnStartStreaming.textContent = "Start Streaming";
  } finally {
    btnStartStreaming.disabled = false;
  }
}

function stopStreamingFlow() {
  btnStartStreaming.disabled = true;
  cleanupLocalResources();
  btnStartStreaming.textContent = "Start Streaming";
  btnStartStreaming.disabled = false;
}

btnStartStreaming.addEventListener("mousedown", () => {
  if (btnStartStreaming.textContent === "Start Streaming") {
    startStreamingFlow();
  } else {
    stopStreamingFlow();
  }
});

(async () => {
  try {
    await initSocket();
  } catch (err) {
    console.error(
      `CLIENT: Initial socket connection failed on page load: ${err}`,
    );
    btnStartStreaming.disabled = true;
    alert("Could not connect to signaling server on page load.");
  }
})();
