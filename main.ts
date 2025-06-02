import { io } from "socket.io-client";
import {
  type Transport,
  type RtpCapabilities,
  Device,
  type Producer,
  type Consumer,
} from "mediasoup-client/types";

let rtpCapabilities: RtpCapabilities;
let device: Device;
let producer: Producer;
let producerTransport: Transport;
let consumer: Consumer;
let consumerTransport: Transport;

const socket = io("wss://localhost:3000/mediasoup");

socket.on("connection-success", ({ socketId }) => {
  console.log("Connected with socket ID:", socketId);
});

socket.on("connect_error", (error) => {
  console.error("Socket connection error:", error);
});

const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
const btnLocalVideo = document.getElementById(
  "btnLocalVideo",
) as HTMLButtonElement;
const btnRtpCapabilities = document.getElementById(
  "btnRtpCapabilities",
) as HTMLButtonElement;
const btnDevice = document.getElementById("btnDevice") as HTMLButtonElement;
const btnCreateSendTransport = document.getElementById(
  "btnCreateSendTransport",
) as HTMLButtonElement;
const btnConnectSendTransport = document.getElementById(
  "btnConnectSendTransport",
) as HTMLButtonElement;
const btnCreateRecvTransport = document.getElementById(
  "btnRecvSendTransport",
) as HTMLButtonElement;
const btnConnectRecvTransport = document.getElementById(
  "btnConnectRecvTransport",
) as HTMLButtonElement;

let params: any = {
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

/**
* Worker
* |-> Router(s)
*     |-> Producer Transport(s)
*         |-> Producer
*     |-> Consumer Transport(s)
*         |-> Consumer
**/

function streamSuccess(stream: MediaStream) {
  localVideo.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  params = { track, ...params };
}

async function createDevice() {
  try {
    device = new Device();

    await device.load({
      routerRtpCapabilities: rtpCapabilities,
    });

    console.log("Device created successfully");
    console.log("RTP Capabilities", device.rtpCapabilities);
  } catch (e) {
    if (e instanceof Error) {
      if (e.name === "UnsupportedError") {
        console.error("Browser not supported for WebRTC");
        alert("Your browser doesn't support the required WebRTC features");
      } else {
        console.error("Device creation error:", e.message);
      }
    } else {
      console.error("Unknown error during device creation:", e);
    }
    throw e;
  }
}

async function getLocalStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { min: 640, max: 1920 },
        height: { min: 400, max: 1080 },
      },
    });
    streamSuccess(stream);
    console.log("Local stream obtained successfully");
  } catch (error) {
    console.error("Error getting local stream:", error);
    alert("Could not access camera. Please check permissions.");
  }
}

function getRtpCapabilities() {
  console.log("Requesting RTP capabilities...");
  socket.emit("getRtpCapabilities", (data: any) => {
    if (data.rtpCapabilities) {
      console.log("Router RTP Capabilities received");
      rtpCapabilities = data.rtpCapabilities;
    } else {
      console.error("Failed to get RTP capabilities");
    }
  });
}

async function createSendTransport() {
  console.log("Creating send transport...");
  socket.emit("createWebRtcTransport", { sender: true }, ({ params }: any) => {
    if (params.error) {
      console.error("Send transport creation error:", params.error);
      return;
    }

    console.log("Send transport params received:", params);

    try {
      producerTransport = device.createSendTransport(params);

      producerTransport.on(
        "connect",
        async ({ dtlsParameters }, callback, errback) => {
          try {
            console.log("Connecting send transport...");
            socket.emit("transport-connect", { dtlsParameters });
            callback();
          } catch (error: any) {
            console.error("Send transport connect error:", error);
            errback(error);
          }
        },
      );

      producerTransport.on("produce", (parameters, callback, errback) => {
        console.log("Producing media...", parameters);

        try {
          socket.emit(
            "transport-produce",
            {
              kind: parameters.kind,
              rtpParameters: parameters.rtpParameters,
              appData: parameters.appData,
            },
            ({ id }: any) => {
              callback({ id });
            },
          );
        } catch (error: any) {
          console.error("Produce error:", error);
          errback(error);
        }
      });

      producerTransport.on("connectionstatechange", (state) => {
        console.log("Producer transport connection state:", state);
        if (state === "failed") {
          console.error("Producer transport connection failed");
        }
      });

      console.log("Send transport created successfully");
    } catch (error) {
      console.error("Error creating send transport:", error);
    }
  });
}

async function connectSendTransport() {
  try {
    console.log("Connecting send transport and producing...");
    producer = await producerTransport.produce(params);

    producer.on("trackended", () => {
      console.log("Producer track ended");
    });

    producer.on("transportclose", () => {
      console.log("Producer transport closed");
    });

    console.log("Producer created successfully:", producer.id);
  } catch (error) {
    console.error("Error connecting send transport:", error);
  }
}

async function createRecvTransport() {
  console.log("Creating receive transport...");
  socket.emit("createWebRtcTransport", { sender: false }, ({ params }: any) => {
    if (params.error) {
      console.error("Receive transport creation error:", params.error);
      return;
    }

    console.log("Receive transport params received:", params);

    try {
      consumerTransport = device.createRecvTransport(params);

      consumerTransport.on(
        "connect",
        async ({ dtlsParameters }, callback, errback) => {
          try {
            console.log("Connecting receive transport...");
            socket.emit("transport-recv-connect", { dtlsParameters });
            callback();
          } catch (error: any) {
            console.error("Receive transport connect error:", error);
            errback(error);
          }
        },
      );

      consumerTransport.on("connectionstatechange", (state) => {
        console.log("Consumer transport connection state:", state);
        if (state === "failed") {
          console.error("Consumer transport connection failed");
        }
      });

      console.log("Receive transport created successfully");
    } catch (error) {
      console.error("Error creating receive transport:", error);
    }
  });
}

async function connectRecvTransport() {
  console.log("Connecting receive transport and consuming...");
  socket.emit(
    "consume",
    {
      rtpCapabilities: device.rtpCapabilities,
    },
    async ({ params }: any) => {
      if (params.error) {
        console.error("Cannot consume:", params.error);
        return;
      }

      console.log("Consumer params received:", params);

      try {
        consumer = await consumerTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });

        const { track } = consumer;
        remoteVideo.srcObject = new MediaStream([track]);

        socket.emit("consumer-resume");
        console.log("Consumer created and resumed successfully");
      } catch (error) {
        console.error("Error consuming:", error);
      }
    },
  );
}

function addClickHandler(
  button: HTMLButtonElement,
  handler: () => Promise<void> | void,
) {
  button.addEventListener("mousedown", async () => {
    try {
      button.disabled = true;
      await handler();
    } catch (error) {
      console.error(`Error in ${handler.name}:`, error);
    } finally {
      button.disabled = false;
    }
  });
}

addClickHandler(btnLocalVideo, getLocalStream);
addClickHandler(btnRtpCapabilities, getRtpCapabilities);
addClickHandler(btnDevice, createDevice);
addClickHandler(btnCreateSendTransport, createSendTransport);
addClickHandler(btnConnectSendTransport, connectSendTransport);
addClickHandler(btnCreateRecvTransport, createRecvTransport);
addClickHandler(btnConnectRecvTransport, connectRecvTransport);
