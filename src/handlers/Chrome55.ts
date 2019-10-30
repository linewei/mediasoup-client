import * as sdpTransform from 'sdp-transform';
import Logger from '../Logger';
import EnhancedEventEmitter from '../EnhancedEventEmitter';
import { UnsupportedError } from '../errors';
import * as utils from '../utils';
import * as ortc from '../ortc';
import * as sdpCommonUtils from './sdp/commonUtils';
import * as sdpPlanBUtils from './sdp/planBUtils';
import RemoteSdp from './sdp/RemoteSdp';
import { IceParameters } from './../Transport';
import { RtpParameters } from '../types';

const logger = new Logger('Chrome55');

const SCTP_NUM_STREAMS = { OS: 1024, MIS: 1024 };

class Handler extends EnhancedEventEmitter
{
	// Got transport local and remote parameters.
	protected _transportReady = false;

	// Remote SDP handler.
	protected _remoteSdp: RemoteSdp;

	// RTCPeerConnection instance.
	protected _pc: any;

	// Whether a DataChannel m=application section has been created.
	protected _hasDataChannelMediaSection = false;

	// DataChannel id value counter. It must be incremented for each new DataChannel.
	protected _nextSctpStreamId = 0;

	constructor(
		{
			iceParameters,
			iceCandidates,
			dtlsParameters,
			sctpParameters,
			iceServers,
			iceTransportPolicy,
			additionalSettings,
			proprietaryConstraints
		}:
		{
			iceParameters: any;
			iceCandidates: any;
			dtlsParameters: any;
			sctpParameters: any;
			iceServers: any[];
			iceTransportPolicy: string;
			additionalSettings: any;
			proprietaryConstraints: any;
		}
	)
	{
		super(logger);

		this._remoteSdp = new RemoteSdp(
			{
				iceParameters,
				iceCandidates,
				dtlsParameters,
				sctpParameters,
				planB : true
			});

		this._pc = new (RTCPeerConnection as any)(
			{
				iceServers         : iceServers || [],
				iceTransportPolicy : iceTransportPolicy || 'all',
				bundlePolicy       : 'max-bundle',
				rtcpMuxPolicy      : 'require',
				sdpSemantics       : 'plan-b',
				...additionalSettings
			},
			proprietaryConstraints);

		// Handle RTCPeerConnection connection status.
		this._pc.addEventListener('iceconnectionstatechange', () =>
		{
			switch (this._pc.iceConnectionState)
			{
				case 'checking':
					this.emit('@connectionstatechange', 'connecting');
					break;
				case 'connected':
				case 'completed':
					this.emit('@connectionstatechange', 'connected');
					break;
				case 'failed':
					this.emit('@connectionstatechange', 'failed');
					break;
				case 'disconnected':
					this.emit('@connectionstatechange', 'disconnected');
					break;
				case 'closed':
					this.emit('@connectionstatechange', 'closed');
					break;
			}
		});
	}

	close(): void
	{
		logger.debug('close()');

		// Close RTCPeerConnection.
		try { this._pc.close(); }
		catch (error) {}
	}

	async getTransportStats(): Promise<any>
	{
		return this._pc.getStats();
	}

	async updateIceServers(
		{ iceServers }:
		{ iceServers: RTCIceServer[] }
	): Promise<void>
	{
		logger.debug('updateIceServers()');

		const configuration = this._pc.getConfiguration();

		configuration.iceServers = iceServers;

		this._pc.setConfiguration(configuration);
	}

	async _setupTransport(
		{ localDtlsRole, localSdpObject = null }:
		{ localDtlsRole: 'client' | 'server'; localSdpObject?: any }
	): Promise<void>
	{
		if (!localSdpObject)
			localSdpObject = sdpTransform.parse(this._pc.localDescription.sdp);

		// Get our local DTLS parameters.
		const dtlsParameters =
			sdpCommonUtils.extractDtlsParameters({ sdpObject: localSdpObject });

		// Set our DTLS role.
		dtlsParameters.role = localDtlsRole;

		// Update the remote DTLS role in the SDP.
		this._remoteSdp.updateDtlsRole(
			localDtlsRole === 'client' ? 'server' : 'client');

		// Need to tell the remote transport about our parameters.
		await this.safeEmitAsPromise('@connect', { dtlsParameters });

		this._transportReady = true;
	}
}

export class SendHandler extends Handler
{
	// Generic sending RTP parameters for audio and video.
	private _sendingRtpParametersByKind: any;

	// Generic sending RTP parameters for audio and video suitable for the SDP
	// remote answer.
	private _sendingRemoteRtpParametersByKind: any;

	// Local stream.
	private _stream: MediaStream;

	// Map of MediaStreamTracks indexed by localId.
	private _mapIdTrack: Map<string, any>;

	// Latest localId.
	private _lastId = 0;

	constructor(data: any)
	{
		super(data);

		this._sendingRtpParametersByKind = data.sendingRtpParametersByKind;

		this._sendingRemoteRtpParametersByKind = data.sendingRemoteRtpParametersByKind;

		this._stream = new MediaStream();

		this._mapIdTrack = new Map();
	}

	async send(
		{ track, encodings, codecOptions }:
		{ track: any; encodings: any; codecOptions: any }
	): Promise<any>
	{
		logger.debug('send() [kind:%s, track.id:%s]', track.kind, track.id);

		this._stream.addTrack(track);
		this._pc.addStream(this._stream);

		let offer = await this._pc.createOffer();
		let localSdpObject = sdpTransform.parse(offer.sdp);
		let offerMediaObject;
		const sendingRtpParameters =
			utils.clone(this._sendingRtpParametersByKind[track.kind]);

		if (!this._transportReady)
			await this._setupTransport({ localDtlsRole: 'server', localSdpObject });

		if (track.kind === 'video' && encodings && encodings.length > 1)
		{
			logger.debug('send() | enabling simulcast');

			localSdpObject = sdpTransform.parse(offer.sdp);
			offerMediaObject = localSdpObject.media.find(
				(m: any) => m.type === 'video'
			);

			sdpPlanBUtils.addLegacySimulcast(
				{
					offerMediaObject,
					track,
					numStreams : encodings.length
				});

			offer = { type: 'offer', sdp: sdpTransform.write(localSdpObject) };
		}

		logger.debug(
			'send() | calling pc.setLocalDescription() [offer:%o]', offer);

		await this._pc.setLocalDescription(offer);

		localSdpObject = sdpTransform.parse(this._pc.localDescription.sdp);
		offerMediaObject = localSdpObject.media
			.find((m: any) => m.type === track.kind);

		// Set RTCP CNAME.
		sendingRtpParameters.rtcp.cname =
			sdpCommonUtils.getCname({ offerMediaObject });

		// Set RTP encodings.
		sendingRtpParameters.encodings =
			sdpPlanBUtils.getRtpEncodings({ offerMediaObject, track });

		// Complete encodings with given values.
		if (encodings)
		{
			for (let idx = 0; idx < sendingRtpParameters.encodings.length; ++idx)
			{
				if (encodings[idx])
					Object.assign(sendingRtpParameters.encodings[idx], encodings[idx]);
			}
		}

		// If VP8 and there is effective simulcast, add scalabilityMode to each
		// encoding.
		if (
			sendingRtpParameters.encodings.length > 1 &&
			sendingRtpParameters.codecs[0].mimeType.toLowerCase() === 'video/vp8'
		)
		{
			for (const encoding of sendingRtpParameters.encodings)
			{
				encoding.scalabilityMode = 'S1T3';
			}
		}

		this._remoteSdp.send(
			{
				offerMediaObject,
				offerRtpParameters  : sendingRtpParameters,
				answerRtpParameters : this._sendingRemoteRtpParametersByKind[track.kind],
				codecOptions
			});

		const answer = { type: 'answer', sdp: this._remoteSdp.getSdp() };

		logger.debug(
			'send() | calling pc.setRemoteDescription() [answer:%o]', answer);

		await this._pc.setRemoteDescription(answer);

		this._lastId++;

		// Insert into the map.
		this._mapIdTrack.set(`${this._lastId}`, track);

		return { localId: this._lastId, rtpParameters: sendingRtpParameters };
	}

	async stopSending({ localId }: { localId: string }): Promise<void>
	{
		logger.debug('stopSending() [localId:%s]', localId);

		const track = this._mapIdTrack.get(localId);

		if (!track)
			throw new Error('track not found');

		this._mapIdTrack.delete(localId);
		this._stream.removeTrack(track);
		this._pc.addStream(this._stream);

		const offer = await this._pc.createOffer();

		logger.debug(
			'stopSending() | calling pc.setLocalDescription() [offer:%o]', offer);

		try
		{
			await this._pc.setLocalDescription(offer);
		}
		catch (error)
		{
			// NOTE: If there are no sending tracks, setLocalDescription() will fail with
			// "Failed to create channels". If so, ignore it.
			if (this._stream.getTracks().length === 0)
			{
				logger.warn(
					'stopSending() | ignoring expected error due no sending tracks: %s',
					error.toString());

				return;
			}

			throw error;
		}

		if (this._pc.signalingState === 'stable')
			return;

		const answer = { type: 'answer', sdp: this._remoteSdp.getSdp() };

		logger.debug(
			'stopSending() | calling pc.setRemoteDescription() [answer:%o]', answer);

		await this._pc.setRemoteDescription(answer);
	}

	async replaceTrack(
		{ localId, track }: // eslint-disable-line @typescript-eslint/no-unused-vars
		{ localId: string; track: MediaStreamTrack }
	): Promise<Error>
	{
		throw new UnsupportedError('not implemented');
	}

	async setMaxSpatialLayer(
		{ local, spatialLayer }: // eslint-disable-line @typescript-eslint/no-unused-vars
		{ local: true; spatialLayer: number }
	): Promise<void>
	{
		throw new UnsupportedError('not supported');
	}

	async getSenderStats(
		{ localId }: // eslint-disable-line @typescript-eslint/no-unused-vars
		{ localId: string }
	): Promise<any>
	{
		throw new UnsupportedError('not implemented');
	}

	async sendDataChannel(
		{
			ordered,
			maxPacketLifeTime,
			maxRetransmits,
			label,
			protocol,
			priority
		}: {
			ordered: boolean;
			maxPacketLifeTime: number;
			maxRetransmits: number;
			label: string;
			protocol: string;
			priority: number;
		}
	): Promise<any>
	{
		logger.debug('sendDataChannel()');

		const options =
		{
			negotiated        : true,
			id                : this._nextSctpStreamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmitTime : maxPacketLifeTime, // NOTE: Old spec.
			maxRetransmits,
			protocol,
			priority
		};

		logger.debug('DataChannel options:%o', options);

		const dataChannel = this._pc.createDataChannel(label, options);

		// Increase next id.
		this._nextSctpStreamId = ++this._nextSctpStreamId % SCTP_NUM_STREAMS.MIS;

		// If this is the first DataChannel we need to create the SDP answer with
		// m=application section.
		if (!this._hasDataChannelMediaSection)
		{
			const offer = await this._pc.createOffer();
			const localSdpObject = sdpTransform.parse(offer.sdp);
			const offerMediaObject = localSdpObject.media
				.find((m: any) => m.type === 'application');

			if (!this._transportReady)
				await this._setupTransport({ localDtlsRole: 'server', localSdpObject });

			logger.debug(
				'sendDataChannel() | calling pc.setLocalDescription() [offer:%o]', offer);

			await this._pc.setLocalDescription(offer);

			this._remoteSdp.sendSctpAssociation({ offerMediaObject });

			const answer = { type: 'answer', sdp: this._remoteSdp.getSdp() };

			logger.debug(
				'sendDataChannel() | calling pc.setRemoteDescription() [answer:%o]', answer);

			await this._pc.setRemoteDescription(answer);

			this._hasDataChannelMediaSection = true;
		}

		const sctpStreamParameters =
		{
			streamId          : options.id,
			ordered           : options.ordered,
			maxPacketLifeTime : options.maxPacketLifeTime,
			maxRetransmits    : options.maxRetransmits
		};

		return { dataChannel, sctpStreamParameters };
	}

	async restartIce(
		{ iceParameters }:
		{ iceParameters: IceParameters }
	): Promise<void>
	{
		logger.debug('restartIce()');

		// Provide the remote SDP handler with new remote ICE parameters.
		this._remoteSdp.updateIceParameters(iceParameters);

		if (!this._transportReady)
			return;

		const offer = await this._pc.createOffer({ iceRestart: true });

		logger.debug(
			'restartIce() | calling pc.setLocalDescription() [offer:%o]', offer);

		await this._pc.setLocalDescription(offer);

		const answer = { type: 'answer', sdp: this._remoteSdp.getSdp() };

		logger.debug(
			'restartIce() | calling pc.setRemoteDescription() [answer:%o]', answer);

		await this._pc.setRemoteDescription(answer);
	}
}

class RecvHandler extends Handler
{
	// Map of MID, RTP parameters and RTCRtpReceiver indexed by local id.
	// Value is an Object with mid and rtpParameters.
	private _mapIdRtpParameters: Map<string, any>;

	constructor(data: any)
	{
		super(data);

		this._mapIdRtpParameters = new Map();
	}

	async receive(
		{ id, kind, rtpParameters }:
		{ id: string; kind: 'audio' | 'video'; rtpParameters: RtpParameters }
	): Promise<any>
	{
		logger.debug('receive() [id:%s, kind:%s]', id, kind);

		const localId = id;
		const mid = kind;
		const streamId = rtpParameters.rtcp.cname;

		this._remoteSdp.receive(
			{
				mid,
				kind,
				offerRtpParameters : rtpParameters,
				streamId,
				trackId            : localId
			});

		const offer = { type: 'offer', sdp: this._remoteSdp.getSdp() };

		logger.debug(
			'receive() | calling pc.setRemoteDescription() [offer:%o]', offer);

		await this._pc.setRemoteDescription(offer);

		let answer = await this._pc.createAnswer();
		const localSdpObject = sdpTransform.parse(answer.sdp);
		const answerMediaObject = localSdpObject.media
			.find((m: any) => String(m.mid) === mid);

		// May need to modify codec parameters in the answer based on codec
		// parameters in the offer.
		sdpCommonUtils.applyCodecParameters(
			{
				offerRtpParameters : rtpParameters,
				answerMediaObject
			});

		answer = { type: 'answer', sdp: sdpTransform.write(localSdpObject) };

		if (!this._transportReady)
			await this._setupTransport({ localDtlsRole: 'client', localSdpObject });

		logger.debug(
			'receive() | calling pc.setLocalDescription() [answer:%o]', answer);

		await this._pc.setLocalDescription(answer);

		const stream = this._pc.getRemoteStreams()
			.find((s: any) => s.id === streamId);
		const track = stream.getTrackById(localId);

		if (!track)
			throw new Error('remote track not found');

		// Insert into the map.
		this._mapIdRtpParameters.set(localId, { mid, rtpParameters });

		return { localId, track };
	}

	async stopReceiving({ localId }: { localId: string }): Promise<void>
	{
		logger.debug('stopReceiving() [localId:%s]', localId);

		const { mid, rtpParameters } = this._mapIdRtpParameters.get(localId);

		// Remove from the map.
		this._mapIdRtpParameters.delete(localId);

		this._remoteSdp.planBStopReceiving(
			{ mid, offerRtpParameters: rtpParameters });

		const offer = { type: 'offer', sdp: this._remoteSdp.getSdp() };

		logger.debug(
			'stopReceiving() | calling pc.setRemoteDescription() [offer:%o]', offer);

		await this._pc.setRemoteDescription(offer);

		const answer = await this._pc.createAnswer();

		logger.debug(
			'stopReceiving() | calling pc.setLocalDescription() [answer:%o]', answer);

		await this._pc.setLocalDescription(answer);
	}

	async getReceiverStats(
		{ localId }: // eslint-disable-line @typescript-eslint/no-unused-vars
		{ localId: string }
	): Promise<any>
	{
		throw new UnsupportedError('not implemented');
	}

	async receiveDataChannel(
		{ sctpStreamParameters, label, protocol }:
		{ sctpStreamParameters: any; label: string; protocol: string }
	): Promise<any>
	{
		logger.debug('receiveDataChannel()');

		const {
			streamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmits
		} = sctpStreamParameters;

		const options =
		{
			negotiated        : true,
			id                : streamId,
			ordered,
			maxPacketLifeTime,
			maxRetransmitTime : maxPacketLifeTime, // NOTE: Old spec.
			maxRetransmits,
			protocol
		};

		logger.debug('DataChannel options:%o', options);

		const dataChannel = this._pc.createDataChannel(label, options);

		// If this is the first DataChannel we need to create the SDP offer with
		// m=application section.
		if (!this._hasDataChannelMediaSection)
		{
			this._remoteSdp.receiveSctpAssociation({ oldDataChannelSpec: true });

			const offer = { type: 'offer', sdp: this._remoteSdp.getSdp() };

			logger.debug(
				'receiveDataChannel() | calling pc.setRemoteDescription() [offer:%o]', offer);

			await this._pc.setRemoteDescription(offer);

			const answer = await this._pc.createAnswer();

			if (!this._transportReady)
			{
				const localSdpObject = sdpTransform.parse(answer.sdp);

				await this._setupTransport({ localDtlsRole: 'client', localSdpObject });
			}

			logger.debug(
				'receiveDataChannel() | calling pc.setRemoteDescription() [answer:%o]', answer);

			await this._pc.setLocalDescription(answer);

			this._hasDataChannelMediaSection = true;
		}

		return { dataChannel };
	}

	async restartIce(
		{ iceParameters }:
		{ iceParameters: IceParameters }
	): Promise<void>
	{
		logger.debug('restartIce()');

		// Provide the remote SDP handler with new remote ICE parameters.
		this._remoteSdp.updateIceParameters(iceParameters);

		if (!this._transportReady)
			return;

		const offer = { type: 'offer', sdp: this._remoteSdp.getSdp() };

		logger.debug(
			'restartIce() | calling pc.setRemoteDescription() [offer:%o]', offer);

		await this._pc.setRemoteDescription(offer);

		const answer = await this._pc.createAnswer();

		logger.debug(
			'restartIce() | calling pc.setLocalDescription() [answer:%o]', answer);

		await this._pc.setLocalDescription(answer);
	}
}

export default class Chrome55
{
	static get label(): string
	{
		return 'Chrome55';
	}

	static async getNativeRtpCapabilities(): Promise<any>
	{
		logger.debug('getNativeRtpCapabilities()');

		const pc = new (RTCPeerConnection as any)(
			{
				iceServers         : [],
				iceTransportPolicy : 'all',
				bundlePolicy       : 'max-bundle',
				rtcpMuxPolicy      : 'require',
				sdpSemantics       : 'plan-b'
			});

		try
		{
			const offer = await pc.createOffer(
				{
					offerToReceiveAudio : true,
					offerToReceiveVideo : true
				});

			try { pc.close(); }
			catch (error) {}

			const sdpObject = sdpTransform.parse(offer.sdp);
			const nativeRtpCapabilities =
				sdpCommonUtils.extractRtpCapabilities({ sdpObject });

			return nativeRtpCapabilities;
		}
		catch (error)
		{
			try { pc.close(); }
			catch (error2) {}

			throw error;
		}
	}

	static async getNativeSctpCapabilities(): Promise<any>
	{
		logger.debug('getNativeSctpCapabilities()');

		return {
			numStreams : SCTP_NUM_STREAMS
		};
	}

	constructor(
		{
			direction,
			iceParameters,
			iceCandidates,
			dtlsParameters,
			sctpParameters,
			iceServers,
			iceTransportPolicy,
			additionalSettings,
			proprietaryConstraints,
			extendedRtpCapabilities
		}:
		{
			direction: string;
			iceParameters: any;
			iceCandidates: any[];
			dtlsParameters: any;
			sctpParameters: any;
			iceServers: any[];
			iceTransportPolicy: string;
			additionalSettings: any;
			proprietaryConstraints: any;
			extendedRtpCapabilities: any;
		}
	)
	{
		logger.debug('constructor() [direction:%s]', direction);

		switch (direction)
		{
			case 'send':
			{
				const sendingRtpParametersByKind =
				{
					audio : ortc.getSendingRtpParameters('audio', extendedRtpCapabilities),
					video : ortc.getSendingRtpParameters('video', extendedRtpCapabilities)
				};

				const sendingRemoteRtpParametersByKind =
				{
					audio : ortc.getSendingRemoteRtpParameters('audio', extendedRtpCapabilities),
					video : ortc.getSendingRemoteRtpParameters('video', extendedRtpCapabilities)
				};

				return new SendHandler(
					{
						iceParameters,
						iceCandidates,
						dtlsParameters,
						sctpParameters,
						iceServers,
						iceTransportPolicy,
						additionalSettings,
						proprietaryConstraints,
						sendingRtpParametersByKind,
						sendingRemoteRtpParametersByKind
					});
			}

			case 'recv':
			{
				return new RecvHandler(
					{
						iceParameters,
						iceCandidates,
						dtlsParameters,
						sctpParameters,
						iceServers,
						iceTransportPolicy,
						additionalSettings,
						proprietaryConstraints
					});
			}
		}
	}
}