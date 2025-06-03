import type {
  RtpCapabilities,
  RtpParameters,
  TransportOptions,
} from "mediasoup-client/types";

export interface RtpCapabilitiesResponse {
  rtpCapabilities: RtpCapabilities;
}

export interface CreateTransportResponse {
  params?: TransportOptions;
  error?: string;
}

export interface ProduceResponse {
  id?: string;
  error?: string;
}

export interface ConsumeResponse {
  params?: {
    id: string;
    producerId: string;
    kind: "audio" | "video";
    rtpParameters: RtpParameters;
  };
  error?: string;
}

export interface NewProducerData {
  producerId: string;
  producerSocketId: string;
  kind: "audio" | "video";
}

export interface ExistingProducersData {
  producers: Array<{
    producerId: string;
    producerSocketId: string;
    kind: "audio" | "video";
  }>;
}

export interface ProducerClosedData {
  producerId: string;
}

export interface ConsumerClosedData {
  consumerId: string;
  producerId: string;
}

export interface ConnectionSuccessData {
  socketId: string;
}
