'use strict';

var EventEmitter = require('events').EventEmitter,
    util = require('util'),

    StateMachine = require('stately.js'),

    debug = require('debug')('amqp10:session'),

    constants = require('./constants'),
    errors = require('./errors'),
    u = require('./utilities'),

    AttachFrame = require('./frames/attach_frame'),
    BeginFrame = require('./frames/begin_frame'),
    DetachFrame = require('./frames/detach_frame'),
    DispositionFrame = require('./frames/disposition_frame'),
    EndFrame = require('./frames/end_frame'),
    FlowFrame = require('./frames/flow_frame'),
    TransferFrame = require('./frames/transfer_frame'),

    Link = require('./link'),
    Connection = require('./connection');



/**
 * A Session is a bidirectional sequential conversation between two containers that provides a
 * grouping for related links. Sessions serve as the context for link communication. Any number
 * of links of any directionality can be <i>attached</i> to a given Session. However, a link
 * may be attached to at most one Session at a time.
 *
 * Session states, from AMQP 1.0 spec:
 *
 <dl>
 <dt>UNMAPPED</dt>
 <dd><p>In the UNMAPPED state, the Session endpoint is not mapped to any incoming or outgoing
 channels on the Connection endpoint. In this state an endpoint cannot send or receive
 frames.</p></dd>

 <dt>BEGIN-SENT</dt>
 <dd><p>In the BEGIN-SENT state, the Session endpoint is assigned an outgoing channel number,
 but there is no entry in the incoming channel map. In this state the endpoint may send
 frames but cannot receive them.</p></dd>

 <dt>BEGIN-RCVD</dt>
 <dd><p>In the BEGIN-RCVD state, the Session endpoint has an entry in the incoming channel
 map, but has not yet been assigned an outgoing channel number. The endpoint may receive
 frames, but cannot send them.</p></dd>

 <dt>MAPPED</dt>
 <dd><p>In the MAPPED state, the Session endpoint has both an outgoing channel number and an
 entry in the incoming channel map. The endpoint may both send and receive
 frames.</p></dd>

 <dt>END-SENT</dt>
 <dd><p>In the END-SENT state, the Session endpoint has an entry in the incoming channel map,
 but is no longer assigned an outgoing channel number. The endpoint may receive frames,
 but cannot send them.</p></dd>

 <dt>END-RCVD</dt>
 <dd><p>In the END-RCVD state, the Session endpoint is assigned an outgoing channel number,
 but there is no entry in the incoming channel map. The endpoint may send frames, but
 cannot receive them.</p></dd>

 <dt>DISCARDING</dt>
 <dd><p>The DISCARDING state is a variant of the END-SENT state where the <code>end</code>
 is triggered by an error. In this case any incoming frames on the session MUST be
 silently discarded until the peer's <code>end</code> frame is received.</p></dd>
 </dl>

 <pre>
                         UNMAPPED< ------------------+
                            |                        |
                    +-------+-------+                |
            S:BEGIN |               | R:BEGIN        |
                    |               |                |
                   \\|/             \\|/               |
                BEGIN-SENT      BEGIN-RCVD           |
                    |               |                |
                    |               |                |
            R:BEGIN |               | S:BEGIN        |
                    +-------+-------+                |
                            |                        |
                           \\|/                       |
                          MAPPED                     |
                            |                        |
              +-------------+-------------+          |
 S:END(error) |       S:END |             | R:END    |
              |             |             |          |
             \\|/           \\|/           \\|/         |
          DISCARDING     END-SENT      END-RCVD      |
              |             |             |          |
              |             |             |          |
        R:END |       R:END |             | S:END    |
              +-------------+-------------+          |
                            |                        |
                            |                        |
                            +------------------------+
  </pre>
 *
 * There is no obligation to retain a Session Endpoint when it is in the UNMAPPED state, i.e.
 * the UNMAPPED state is equivalent to a NONEXISTENT state.
 *
 * Note: This implementation *assumes* it is the client, and thus will always be the one BEGIN-ing a Session.
 *
 * @param {Connection} conn     Connection to bind session to.
 * @constructor
 */
function Session(conn) {
  Session.super_.call(this);
  this.setMaxListeners(100);
  this.connection = conn;
  this.mapped = false;
  this.remoteChannel = undefined;
  this._allocatedHandles = {};
  this._linksByName = {};
  this._linksByRemoteHandle = {};
  this._senderLinks = [];
  this._transfersInFlight = {};

  var self = this;
  var stateMachine = {
    'UNMAPPED': {
      sendBegin: function() {
        return this.BEGIN_SENT;
      }
    },
    'BEGIN_SENT': {
      beginReceived: function() {
        return this.MAPPED;
      }
    },
    'MAPPED': {
      sendEnd: function() {
        return this.END_SENT;
      },
      endReceived: function() {
        return this.END_RCVD;
      }
    },
    'END_SENT': {
      endReceived: function() {
        return this.UNMAPPED;
      }
    },
    'DISCARDING': {
      endReceived: function() {
        return this.UNMAPPED;
      }
    },
    'END_RCVD': {
      sendEnd: function() {
        return this.UNMAPPED;
      }
    }
  };

  this.sessionSM = new StateMachine(stateMachine).bind(function(event, oldState, newState) {
    debug('Transitioning from ' + oldState + ' to ' + newState + ' due to ' + event);
  });
}

util.inherits(Session, EventEmitter);

// Events
Session.Mapped = 'session:mapped';
Session.Unmapped = 'session:unmapped';

// Since 'error' events are "special" in Node (as in halt-the-process special),
// using a custom event for errors we receive from the other endpoint. Provides
// received AMQPError as an argument.
Session.ErrorReceived = 'session:errorReceived';

// On successful attach, Link given as argument.
Session.LinkAttached = 'session:linkAttached';

// On completion of detach, Link given as argument.
Session.LinkDetached = 'session:linkDetached';

// On receipt of a disposition frame, called with the first and last
// delivery-ids involved, whether they were settled, and the state.
Session.DispositionReceived = 'session:dispositionReceived';

Session.prototype.begin = function(sessionPolicy) {
  var sessionParams = u.deepMerge(sessionPolicy.options);
  u.assertArguments(sessionParams, ['nextOutgoingId', 'incomingWindow', 'outgoingWindow']);

  this.policy = sessionPolicy;
  this.channel = this.connection.associateSession(this);
  this._sessionParams = sessionParams;
  this._initialOutgoingId = sessionParams.nextOutgoingId;

  this.sessionSM.sendBegin();
  var self = this;
  this._processFrameEH = function(frame) { self._processFrame(frame); };
  this.connection.on(Connection.FrameReceived, this._processFrameEH);
  var beginFrame = new BeginFrame(this._sessionParams);
  beginFrame.channel = this.channel;
  this.connection.sendFrame(beginFrame);
};

Session.prototype.attachLink = function(linkPolicy) {
  var policy = u.deepMerge(linkPolicy);
  if (typeof policy.options.name === 'function') policy.options.name = policy.options.name();
  policy.options.handle = this._nextHandle();
  var newLink = new Link(this, policy.options.handle, policy);
  this._allocatedHandles[policy.options.handle] = newLink;
  this._linksByName[policy.options.name] = newLink;
  newLink.attach();
  if (newLink.role === constants.linkRole.sender) {
    this._senderLinks.push(newLink);
  }
  return newLink;
};

Session.prototype._linkAttached = function(link) {
  this.emit(Session.LinkAttached, link);
};

Session.prototype._linkDetached = function(link) {
  this.emit(Session.LinkDetached, link);
};

/**
 *
 * @param {Link} link
 * @param {Message} message
 * @param {*} options
 */
Session.prototype.sendMessage = function(link, message, options) {
  var messageId = this._sessionParams.nextOutgoingId;
  this._sessionParams.nextOutgoingId++;
  this._sessionParams.remoteIncomingWindow--;
  this._sessionParams.outgoingWindow--;
  if (this._sessionParams.remoteIncomingWindow < 0) {
    if (this.policy.enableSessionFlowControl) {
      throw new errors.OverCapacityError('Cannot send message - over Session window capacity (' + this._sessionParams.remoteIncomingWindow + ' window)');
    } else {
      this._sessionParams.remoteIncomingWindow = this._sessionParams.outgoingWindow = 0;
    }
  }

  this._transfersInFlight[messageId] = { message: message, options: options, sent: Date.now() };
  return link._sendMessage(messageId, message, options);
};

Session.prototype.addWindow = function(windowSize, flowOptions) {
  var opts = flowOptions || {};
  this._sessionParams.incomingWindow += windowSize;
  opts.nextIncomingId = this._sessionParams.nextIncomingId;
  opts.incomingWindow = this._sessionParams.incomingWindow;
  opts.nextOutgoingId = this._sessionParams.nextOutgoingId;
  opts.outgoingWindow = this._sessionParams.outgoingWindow;
  opts.handle = null;
  opts.available = null;
  opts.deliveryCount = null;
  opts.drain = false;
  var flow = new FlowFrame(opts);
  flow.channel = this.channel;
  this.connection.sendFrame(flow);
};

Session.prototype.detachLink = function(link) {
  return link.detach();
};

Session.prototype.end = function() {
  if (this.remoteChannel !== undefined) {
    this.sessionSM.sendEnd();
    this._sendEnd();
    if (this.sessionSM.getMachineState() === 'UNMAPPED') this._unmap();
  } else {
    console.warn('Attempt to end session on channel ' + this.channel + ' before it is mapped.');
    this._unmap();
  }
};

Session.prototype._nextHandle = function() {
  for (var hid = 0; hid <= this._sessionParams.handleMax; ++hid) {
    if (this._allocatedHandles[hid] === undefined) {
      this._allocatedHandles[hid] = true; // Will be replaced by link itself.
      return hid;
    }
  }
  throw new errors.OverCapacityError('Out of available handles (Max = ' + this._sessionParams.handleMax + ')');
};

Session.prototype._processFrame = function(frame) {
  if (frame instanceof BeginFrame && (frame.remoteChannel === this.channel)) {
    debug('processing frame(' + frame.constructor.name + '): ' + JSON.stringify(frame));
    this.sessionSM.beginReceived();
    this._beginReceived(frame);
    return;
  }

  if (frame.channel === undefined || frame.channel !== this.remoteChannel) {
    debug('invalid frame(' + frame.constructor.name + '): ' + JSON.stringify(frame));
    return;
  }

  debug('processing frame(' + frame.constructor.name + '): ' + JSON.stringify(frame));
  if (frame instanceof EndFrame) {
    this.sessionSM.endReceived();
    this._endReceived(frame);
    if (this.sessionSM.getMachineState() !== 'UNMAPPED') {
      this.sessionSM.sendEnd();
      this._sendEnd();
    }
    this._unmap();
  } else if (frame instanceof AttachFrame) {
    if (frame.name && this._linksByName[frame.name]) {
      this._linksByName[frame.name]._attachReceived(frame);
    } else {
      // @todo Proper error reporting.  Should we shut down session?
      console.warn('received Attach for unknown link(' + frame.name + '): ' + JSON.stringify(frame));
    }
  } else if (frame instanceof DetachFrame) {
    if (frame.handle !== undefined && this._linksByRemoteHandle[frame.handle]) {
      this._linksByRemoteHandle[frame.handle]._detachReceived(frame);
    } else {
      // @todo Proper error reporting.  Should we shut down session?
      console.warn('received Detach for unknown link(' + frame.handle + '): ' + JSON.stringify(frame));
    }
  } else if (frame instanceof FlowFrame) {
    this._flowReceived(frame);
    if (frame.handle !== null) {
      if (this._linksByRemoteHandle[frame.handle]) {
        this._linksByRemoteHandle[frame.handle]._flowReceived(frame);
      } else {
        // @todo Proper error reporting.  Should we shut down session?
        console.warn('received Flow for unknown link(' + frame.handle + '): ' + JSON.stringify(frame));
      }
    } else {
      this._senderLinks.forEach(function (senderLink) {
        senderLink._flowReceived(frame);
      });
    }
  } else if (frame instanceof TransferFrame) {
    if (frame.handle !== null && this._linksByRemoteHandle[frame.handle]) {
      this._transferReceived(frame);
      this._linksByRemoteHandle[frame.handle]._messageReceived(frame);
    } else {
      console.warn('received Transfer frame for unknown link(' + frame.handle + '): ' + JSON.stringify(frame));
    }
  } else if (frame instanceof DispositionFrame) {
    //DispositionFrame: {"frameType":0,"channel":0,"role":true,"first":10000,"last":null,
    // "settled":true,"state":{"descriptor":{"buffer":[0,0,0,0,0,0,0,36],"offset":0}},"batchable":null}
    if (frame.role !== constants.linkRole.receiver) {
      debug('not yet processing "sender" Disposition frames');
    } else {
      var first = frame.first;
      var last = frame.last || first;
      var settled = frame.settled;

      if (settled) {
        for (var messageId = first; messageId <= last; ++messageId) {
          if (this._transfersInFlight[messageId]) {
            var delta = Date.now() - this._transfersInFlight[messageId].sent;
            delete this._transfersInFlight[messageId];
            debug('message ' + messageId + ' settled in ' + delta + ' ms');
          } else {
            debug('invalid messageId: ' + messageId);
          }
        }
      } else {
        debug('not settled, first: ' + first + ', last: ' + last);
      }

      this.emit(Session.DispositionReceived, {
        first: first,
        last: last,
        settled: settled,
        state: frame.state
      });
    }
  } else {
    debug('not yet processing frames of type: ' + frame.constructor.name);
  }
};

Session.prototype._beginReceived = function(frame) {
  this.remoteChannel = frame.channel;
  this._sessionParams.nextIncomingId = frame.nextOutgoingId;
  this._sessionParams.remoteIncomingWindow = frame.incomingWindow;
  this._sessionParams.remoteOutgoingWindow = frame.outgoingWindow;
  this._sessionParams.handleMax = this._sessionParams.handleMax ?
      Math.min(this._sessionParams.handleMax, frame.handleMax || constants.defaultHandleMax)
        : (frame.handleMax || constants.defaultHandleMax);
  debug('On BEGIN_RCVD, setting params to (' + this._sessionParams.nextIncomingId + ',' + this._sessionParams.remoteIncomingWindow + ',' +
        this._sessionParams.remoteOutgoingWindow + ',' + this._sessionParams.handleMax + ')');
  // @todo Cope with capabilities and properties
  this.mapped = true;
  this.emit(Session.Mapped, this);
};

Session.prototype._flowReceived = function(frame) {
  this._sessionParams.nextIncomingId = frame.nextOutgoingId;
  this._sessionParams.remoteOutgoingWindow = frame.outgoingWindow;
  if (frame.nextIncomingId === undefined || frame.nextIncomingId === null) {
    this._sessionParams.remoteIncomingWindow = this._initialOutgoingId +
            frame.incomingWindow - this._sessionParams.nextOutgoingId;
    debug('New Incoming Window (no known id): ' + this._sessionParams.remoteIncomingWindow + ' = ' +
            this._initialOutgoingId + ' + ' + frame.incomingWindow + ' - ' + this._sessionParams.nextOutgoingId);
  } else {
    this._sessionParams.remoteIncomingWindow = frame.nextIncomingId +
            frame.incomingWindow - this._sessionParams.nextOutgoingId;
    debug('New Incoming Window (known id): ' + this._sessionParams.remoteIncomingWindow + ' = ' +
        frame.nextIncomingId + ' + ' + frame.incomingWindow + ' - ' + this._sessionParams.nextOutgoingId);
  }
};

Session.prototype._transferReceived = function(frame) {
  this._sessionParams.incomingWindow--;
  this._sessionParams.remoteOutgoingWindow--;

  if (this._sessionParams.incomingWindow < 0) {
    // @todo Shut down session since sender is not respecting window.
    debug('Transfer frame received when no incoming window remaining, should shut down session but for now being tolerant.');
  }

  if (frame.deliveryId !== undefined && frame.deliveryId !== null) {
    this._sessionParams.nextIncomingId = frame.deliveryId + 1;
  }
};

Session.prototype._endReceived = function(frame) {
  if (frame.error) {
    this.emit(Session.ErrorReceived, frame.error);
  }
};

Session.prototype._sendEnd = function(frame) {
  var endFrame = new EndFrame();
  endFrame.channel = this.channel;
  this.connection.sendFrame(endFrame);
};

Session.prototype._unmap = function() {
  if (this.connection !== undefined && this.channel !== undefined) {
    this.connection.removeListener(Connection.FrameReceived, this._processFrameEH);
    this.connection.dissociateSession(this.channel);
    this.remoteChannel = undefined;
    this.channel = undefined;
    this.mapped = false;
    this.emit(Session.Unmapped);
  }
};

module.exports = Session;
