import { io, type Socket } from "socket.io-client";
import {
  type Transport,
  type RtpCapabilities as ClientRtpCapabilities,
  Device,
  type Producer,
  type Consumer,
  type DtlsParameters,
  type RtpParameters,
  type TransportOptions,
  type IceCandidate,
  type IceParameters,
  type AppData,
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

let socket: Socket;
let device: Device;
let clientRtpCapabilities: ClientRtpCapabilities;
let producerTransport: Transport | null = null;
let videoProducer: Producer | null = null;
let audioProducer: Producer | null = null;
let consumerTransport: Transport<AppData>;
const webRtcConsumers = new Map<string, Consumer>();
let localStream: MediaStream | null = null;
let isReadyToConsume = false;
let pendingConsumes: string[] = [];

const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
const remoteAudio = document.getElementById("remoteAudio") as HTMLAudioElement;
const btnStartStreaming = document.getElementById(
  "btnStartStreaming",
) as HTMLButtonElement;

const videoParams = {
  encodings: [
    { rid: "r0", maxBitrate: 100000, scalabilityMode: "S1T3" },
    { rid: "r1", maxBitrate: 300000, scalabilityMode: "S1T3" },
    { rid: "r2", maxBitrate: 900000, scalabilityMode: "S1T3" },
  ],
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

let remoteVideoStream: MediaStream | null = null;
let remoteAudioStream: MediaStream | null = null;

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
  socket = io("wss://localhost:3000/mediasoup", {
    rejectUnauthorized: false,
  });

  socket.on("connection-success", (data: ConnectionSuccessData) => {
    console.log(
      `CLIENT (${socket.id}): Connected to Mediasoup server. My socket ID:`,
      data.socketId,
    );
  });

  socket.on("connect_error", (error) => {
    console.error(`CLIENT (${socket.id}): Socket connection error:`, error);
    alert(`Failed to connect to signaling server: ${error.message}.`);
    btnStartStreaming.disabled = true;
  });

  socket.on("disconnect", () => {
    console.warn(`CLIENT (${socket.id}): Disconnected from Mediasoup server`);
    cleanupLocalResources();
  });

  socket.on("new-producer", async (data: NewProducerData) => {
    console.log(
      `CLIENT (${socket.id}): Event 'new-producer' received for P2P WebRTC:`,
      data,
    );
    if (data.producerSocketId === socket.id) {
      console.log(
        `CLIENT (${socket.id}): Ignoring my own new producer broadcast.`,
      );
      return;
    }
    if (!webRtcConsumers.has(data.producerId)) {
      if (isReadyToConsume) {
        console.log(
          `CLIENT (${socket.id}): Ready to consume new ${data.kind} producer: ${data.producerId}`,
        );
        await consumeWebRtcStream(data.producerId);
      } else {
        console.log(
          `CLIENT (${socket.id}): Queueing new producer ${data.producerId} until ready`,
        );
        pendingConsumes.push(data.producerId);
      }
    } else {
      console.log(
        `CLIENT (${socket.id}): Already WebRTC consuming producer ${data.producerId}`,
      );
    }
  });

  socket.on("producer-closed", (data: ProducerClosedData) => {
    console.log(
      `CLIENT (${socket.id}): Event 'producer-closed' received for P2P WebRTC. Producer ${data.producerId} closed on server.`,
    );
    const consumer = webRtcConsumers.get(data.producerId);
    if (consumer) {
      handleWebRtcConsumerClosed(consumer);
      webRtcConsumers.delete(data.producerId);
    }
  });

  socket.on("existing-producers", async (data: ExistingProducersData) => {
    console.log(
      `CLIENT (${socket.id}): Received 'existing-producers'`,
      data.producers,
    );
    for (const producerInfo of data.producers) {
      console.log(
        `CLIENT (${socket.id}): Processing existing producer:`,
        producerInfo,
      );
      if (producerInfo.producerSocketId === socket.id) {
        console.log(
          `CLIENT (${socket.id}): Ignoring own existing producer ${producerInfo.producerId}`,
        );
        continue;
      }
      if (!webRtcConsumers.has(producerInfo.producerId)) {
        if (isReadyToConsume) {
          console.log(
            `CLIENT (${socket.id}): Ready to consume existing P:${producerInfo.producerId}`,
          );
          await consumeWebRtcStream(producerInfo.producerId);
        } else {
          console.log(
            `CLIENT (${socket.id}): Queueing existing P:${producerInfo.producerId} until ready`,
          );
          pendingConsumes.push(producerInfo.producerId);
        }
      } else {
        console.log(
          `CLIENT (${socket.id}): Already consuming or attempted P:${producerInfo.producerId}`,
        );
      }
    }
  });

  socket.on("consumer-closed", (data: ConsumerClosedData) => {
    console.log(
      `CLIENT (${socket.id}): Event 'consumer-closed' for P2P WebRTC. My consumer ${data.consumerId} (for P ${data.producerId}) closed by server.`,
    );
    const consumer = Array.from(webRtcConsumers.values()).find(
      (c) => c.id === data.consumerId,
    );
    if (consumer) {
      handleWebRtcConsumerClosed(consumer);
      webRtcConsumers.delete(consumer.producerId);
    }
  });
}

function handleWebRtcConsumerClosed(consumer: Consumer) {
  console.log(
    `CLIENT (${socket.id}): Handling closed WebRTC consumer: ${consumer.id}, kind: ${consumer.kind}, P_ID: ${consumer.producerId}`,
  );
  if (consumer.kind === "video") {
    if (
      remoteVideoStream?.getTracks().some((t) => t.id === consumer.track.id)
    ) {
      remoteVideoStream.removeTrack(consumer.track);
      if (remoteVideoStream.getTracks().length === 0) {
        remoteVideo.srcObject = null;
        remoteVideoStream = null;
        console.log(`CLIENT (${socket.id}): Remote P2P video stream cleared`);
      }
    }
  } else if (consumer.kind === "audio") {
    if (
      remoteAudioStream?.getTracks().some((t) => t.id === consumer.track.id)
    ) {
      remoteAudioStream.removeTrack(consumer.track);
      if (remoteAudioStream.getTracks().length === 0) {
        remoteAudio.srcObject = null;
        remoteAudioStream = null;
        console.log(`CLIENT (${socket.id}): Remote P2P audio stream cleared`);
      }
    }
  }
  if (!consumer.closed) consumer.close();
}

function cleanupLocalResources() {
  console.log(`CLIENT (${socket.id}): Cleaning up local Mediasoup resources.`);

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
  remoteAudio.srcObject = null;
  remoteVideoStream = null;
  remoteAudioStream = null;

  btnStartStreaming.textContent = "Start Streaming";
  btnStartStreaming.disabled = false;
}

async function getLocalVideo(): Promise<MediaStream | null> {
  console.log(`CLIENT (${socket.id}): Requesting local audio/video stream...`);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
    });
    localVideo.srcObject = stream;
    localStream = stream;
    console.log(`CLIENT (${socket.id}): Local audio/video stream acquired.`);
    return stream;
  } catch (error) {
    console.error(`CLIENT (${socket.id}): Error getting local media:`, error);
    alert("Could not access camera/microphone. Check permissions.");
    return null;
  }
}

async function loadDevice() {
  if (device?.loaded) {
    console.log(`CLIENT (${socket.id}): Device already loaded.`);
    return;
  }
  console.log(`CLIENT (${socket.id}): Loading Mediasoup device...`);
  try {
    const data = (await socket.emitWithAck(
      "getRtpCapabilities",
    )) as RtpCapabilitiesResponse;

    if (!data || !data.rtpCapabilities) {
      throw new Error("No RTP capabilities from server.");
    }

    console.log(`CLIENT (${socket.id}): Received router RTP capabilities.`);
    clientRtpCapabilities = data.rtpCapabilities;

    device = new Device();
    await device.load({ routerRtpCapabilities: clientRtpCapabilities });
    console.log(
      `CLIENT (${socket.id}): Mediasoup device loaded. Device Capabilities:`,
      device.rtpCapabilities.codecs?.map((c) => c.mimeType),
    );
  } catch (error) {
    console.error(
      `CLIENT (${socket.id}): Error loading Mediasoup device:`,
      error,
    );
    if ((error as Error).name === "UnsupportedError")
      alert("Browser not supported.");
    throw error;
  }
}

async function createSendTransport() {
  console.log(
    `CLIENT (${socket.id}): Creating send transport (for producing)...`,
  );
  const transportParams = await new Promise<TransportOptions>(
    (resolve, reject) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: true },
        (response: CreateTransportResponse) => {
          if (response.error || !response.params)
            reject(
              new Error(
                response.error || "No transport params for send transport",
              ),
            );
          else resolve(response.params);
        },
      );
    },
  );
  producerTransport = device.createSendTransport(transportParams);
  producerTransport.on(
    "connect",
    async ({ dtlsParameters }, callback, errback) => {
      try {
        socket.emit("transport-connect", {
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
    async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        socket.emit(
          "transport-produce",
          { transportId: producerTransport?.id, kind, rtpParameters, appData },
          (response: ProduceResponse) => {
            if (response.error || !response.id)
              errback(
                new Error(response.error || "No producer id from server"),
              );
            else {
              callback({ id: response.id });
              console.log(
                `CLIENT (${socket.id}): Produced ${kind}, server ID: ${response.id}`,
              );
            }
          },
        );
      } catch (error) {
        errback(error as Error);
      }
    },
  );
  producerTransport.on("connectionstatechange", (state) =>
    console.log(`CLIENT (${socket.id}): Send transport state: ${state}`),
  );
  console.log(`CLIENT (${socket.id}): Send transport created.`);
}

async function createRecvTransport() {
  console.log(
    `CLIENT (${socket.id}): Creating recv transport (for WebRTC consuming)...`,
  );
  const transportParams = await new Promise<TransportOptions>(
    (resolve, reject) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: false },
        (response: CreateTransportResponse) => {
          if (response.error || !response.params)
            reject(
              new Error(
                response.error || "No transport params for recv transport",
              ),
            );
          else resolve(response.params);
        },
      );
    },
  );
  consumerTransport = device.createRecvTransport(transportParams);
  consumerTransport.on(
    "connect",
    async ({ dtlsParameters }, callback, errback) => {
      try {
        socket.emit("transport-connect", {
          transportId: consumerTransport?.id,
          dtlsParameters,
        });
        callback();
      } catch (error) {
        errback(error as Error);
      }
    },
  );
  consumerTransport.on("connectionstatechange", (state) =>
    console.log(`CLIENT (${socket.id}): Recv transport state: ${state}`),
  );
  console.log(
    `CLIENT (${socket.id}): Recv transport created with ID: ${consumerTransport.id}`,
  );
}

async function startProducingVideo() {
  if (!localStream || !producerTransport) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) {
    console.error(`CLIENT (${socket.id}): No video track for producer.`);
    return;
  }
  try {
    videoProducer = await producerTransport.produce({
      track: videoTrack,
      ...videoParams,
      appData: { mediaTag: "cam-video" },
    });
    videoProducer.on("trackended", () => {
      console.warn(`CLIENT (${socket.id}): Video producer track ended.`);
      stopStreamingFlow();
    });
    videoProducer.on("transportclose", () => {
      console.warn(`CLIENT (${socket.id}): Video producer transport closed.`);
      videoProducer = null;
    });
    console.log(
      `CLIENT (${socket.id}): Video producer created, ID:`,
      videoProducer.id,
    );
  } catch (error) {
    console.error(`CLIENT (${socket.id}): Error producing video:`, error);
  }
}

async function startProducingAudio() {
  if (!localStream || !producerTransport) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) {
    console.error(`CLIENT (${socket.id}): No audio track for producer.`);
    return;
  }
  try {
    audioProducer = await producerTransport.produce({
      track: audioTrack,
      appData: { mediaTag: "mic-audio" },
    });
    audioProducer.on("trackended", () => {
      console.warn(`CLIENT (${socket.id}): Audio producer track ended.`);
    });
    audioProducer.on("transportclose", () => {
      console.warn(`CLIENT (${socket.id}): Audio producer transport closed.`);
      audioProducer = null;
    });
    console.log(
      `CLIENT (${socket.id}): Audio producer created, ID:`,
      audioProducer.id,
    );
  } catch (error) {
    console.error(`CLIENT (${socket.id}): Error producing audio:`, error);
  }
}

async function consumeWebRtcStream(producerIdToConsume: string) {
  console.log(
    `CLIENT (${socket.id}): [WebRTC Consume] Attempting for P:${producerIdToConsume}`,
  );

  if (!device || !device.loaded) {
    console.log(
      `CLIENT (${socket.id}): [WebRTC Consume] Device not loaded for P:${producerIdToConsume}. Loading...`,
    );
    try {
      await loadDevice();
    } catch (err) {
      console.error(
        `CLIENT (${socket.id}): [WebRTC Consume] Failed to load device for P:${producerIdToConsume}`,
        err,
      );
      return;
    }
  }

  if (!consumerTransport || consumerTransport.closed) {
    console.log(
      `CLIENT (${socket.id}): [WebRTC Consume] Recv transport not ready/closed for P:${producerIdToConsume}. Creating...`,
    );
    try {
      await createRecvTransport();
      if (!consumerTransport || consumerTransport.closed) {
        console.error(
          `CLIENT (${socket.id}): [WebRTC Consume] Failed to create/ensure recv transport for P:${producerIdToConsume}.`,
        );
        return;
      }
      console.log(
        `CLIENT (${socket.id}): [WebRTC Consume] Recv transport ready for P:${producerIdToConsume}. ID: ${consumerTransport.id}`,
      );
    } catch (err) {
      console.error(
        `CLIENT (${socket.id}): [WebRTC Consume] Error creating recv transport for P:${producerIdToConsume}`,
        err,
      );
      return;
    }
  }

  if (!device.rtpCapabilities) {
    console.error(
      `CLIENT (${socket.id}): [WebRTC Consume] Device RTP capabilities missing for P:${producerIdToConsume}.`,
    );
    return;
  }

  if (webRtcConsumers.has(producerIdToConsume)) {
    console.log(
      `CLIENT (${socket.id}): [WebRTC Consume] Already consuming producer ${producerIdToConsume}`,
    );
    return;
  }

  try {
    console.log(
      `CLIENT (${socket.id}): [WebRTC Consume] Emitting "consume" to server for P:${producerIdToConsume} on T:${consumerTransport?.id}`,
    );
    const data = await new Promise<ConsumeResponse>((resolve, reject) => {
      socket.emit(
        "consume",
        {
          consumerTransportId: consumerTransport.id,
          producerId: producerIdToConsume,
          rtpCapabilities: device.rtpCapabilities,
        },
        (response: ConsumeResponse) => {
          if (response.error) {
            console.error(
              `CLIENT (${socket.id}): [WebRTC Consume] Server error for P:${producerIdToConsume}: ${response.error}`,
            );
            reject(new Error(response.error));
          } else if (!response.params) {
            console.error(
              `CLIENT (${socket.id}): [WebRTC Consume] No params in consume response for P:${producerIdToConsume}`,
            );
            reject(new Error("No params in consume response"));
          } else {
            console.log(
              `CLIENT (${socket.id}): [WebRTC Consume] Received consume params for P:${producerIdToConsume}`,
              response.params,
            );
            resolve(response);
          }
        },
      );
    });

    if (!data.params) {
      throw new Error("No params in consume response");
    }

    const consumer = await consumerTransport.consume({
      id: data.params.id,
      producerId: data.params.producerId,
      kind: data.params.kind,
      rtpParameters: data.params.rtpParameters,
      appData: { source: "webrtc-p2p" },
    });
    webRtcConsumers.set(consumer.producerId, consumer);
    console.log(
      `CLIENT (${socket.id}): [WebRTC Consume] WebRTC Consumer created: ${consumer.id}, Kind: ${consumer.kind} for P:${consumer.producerId}`,
    );

    consumer.on("transportclose", () => {
      console.warn(
        `CLIENT (${socket.id}): [WebRTC Consume] Consumer ${consumer.id} transport closed.`,
      );
      webRtcConsumers.delete(consumer.producerId);
    });
    consumer.on("@close", () => {
      console.warn(
        `CLIENT (${socket.id}): [WebRTC Consume] @close ${consumer.id} closed.`,
      );
      handleWebRtcConsumerClosed(consumer);
      webRtcConsumers.delete(consumer.producerId);
    });
    consumer.on("trackended", () => {
      console.warn(
        `CLIENT (${socket.id}): [WebRTC Consume] Track for consumer ${consumer.id} ended.`,
      );
      handleWebRtcConsumerClosed(consumer);
      webRtcConsumers.delete(consumer.producerId);
    });

    if (consumer.kind === "video") {
      if (!remoteVideoStream) {
        remoteVideoStream = new MediaStream();
        remoteVideo.srcObject = remoteVideoStream;
      }
      remoteVideoStream.addTrack(consumer.track);
      console.log(
        `CLIENT (${socket.id}): [WebRTC Consume] Added remote video track to stream for P:${consumer.producerId}.`,
      );
    } else if (consumer.kind === "audio") {
      if (!remoteAudioStream) {
        remoteAudioStream = new MediaStream();
        remoteAudio.srcObject = remoteAudioStream;
      }
      remoteAudioStream.addTrack(consumer.track);
      console.log(
        `CLIENT (${socket.id}): [WebRTC Consume] Added remote audio track to stream for P:${consumer.producerId}.`,
      );
    }

    console.log(
      `CLIENT (${socket.id}): [WebRTC Consume] Emitting "consumer-resume" for ${consumer.id}.`,
    );
    socket.emit("consumer-resume", { consumerId: consumer.id });
  } catch (error) {
    console.error(
      `CLIENT (${socket.id}): [WebRTC Consume] Error consuming P2P stream for producer ${producerIdToConsume}:`,
      error,
    );
  }
}

async function startStreamingFlow() {
  btnStartStreaming.disabled = true;
  btnStartStreaming.textContent = "Starting...";
  try {
    if (!socket || !socket.connected) {
      console.log(
        `CLIENT (${socket.id || "unidentified"}): Socket not connected. Initializing...`,
      );
      await initSocket();
      if (!socket.connected) {
        await new Promise<void>((resolve) => {
          socket.once("connect", () => {
            console.log(
              `CLIENT (${socket.id}): Socket connected in startStreamingFlow.`,
            );
            resolve();
          });
          setTimeout(() => {
            if (!socket.connected)
              console.warn(
                "CLIENT: Socket connection timeout in startStreamingFlow.",
              );
            resolve();
          }, 3000);
        });
      }
      if (!socket.connected)
        throw new Error("Failed to connect to signaling server after init.");
    }

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
      `CLIENT (${socket.id || "unidentified"}): Error during startStreamingFlow:`,
      error,
    );
    alert(`Could not start streaming: ${(error as Error).message}`);
    btnStartStreaming.textContent = "Start Streaming";
  } finally {
    btnStartStreaming.disabled = false;
  }
}

function stopStreamingFlow() {
  console.log(`CLIENT (${socket.id}): Stopping streams...`);
  btnStartStreaming.disabled = true;
  cleanupLocalResources();
  btnStartStreaming.textContent = "Start Streaming";
  btnStartStreaming.disabled = false;
  console.log(
    `CLIENT (${socket.id}): Streaming stopped and resources cleaned up.`,
  );
}

btnStartStreaming.addEventListener("click", () => {
  if (btnStartStreaming.textContent === "Start Streaming") {
    startStreamingFlow();
  } else {
    stopStreamingFlow();
  }
});

initSocket()
  .then(() => {})
  .catch((err) => {
    console.error(
      "CLIENT: Initial socket connection failed on page load:",
      err,
    );
    btnStartStreaming.disabled = true;
    alert("Could not connect to signaling server on page load.");
  });
