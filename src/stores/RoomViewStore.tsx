/*
Copyright 2017 Vector Creations Ltd
Copyright 2017, 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React from "react";
import { Store } from 'flux/utils';
import { MatrixError } from "matrix-js-sdk/src/http-api";

import dis from '../dispatcher/dispatcher';
import { MatrixClientPeg } from '../MatrixClientPeg';
import * as sdk from '../index';
import Modal from '../Modal';
import { _t } from '../languageHandler';
import { getCachedRoomIDForAlias, storeRoomAliasInCache } from '../RoomAliasCache';
import { ActionPayload } from "../dispatcher/payloads";
import { Action } from "../dispatcher/actions";
import { retry } from "../utils/promise";
import CountlyAnalytics from "../CountlyAnalytics";

const NUM_JOIN_RETRY = 5;

const INITIAL_STATE = {
    // Whether we're joining the currently viewed room (see isJoining())
    joining: false,
    // Any error that has occurred during joining
    joinError: null,
    // The room ID of the room currently being viewed
    roomId: null,

    // The event to scroll to when the room is first viewed
    initialEventId: null,
    initialEventPixelOffset: null,
    // Whether to highlight the initial event
    isInitialEventHighlighted: false,

    // The room alias of the room (or null if not originally specified in view_room)
    roomAlias: null,
    // Whether the current room is loading
    roomLoading: false,
    // Any error that has occurred during loading
    roomLoadError: null,

    quotingEvent: null,

    replyingToEvent: null,

    shouldPeek: false,

    viaServers: [],

    wasContextSwitch: false,
};

/**
 * A class for storing application state for RoomView. This is the RoomView's interface
*  with a subset of the js-sdk.
 *  ```
 */
class RoomViewStore extends Store<ActionPayload> {
    private state = INITIAL_STATE; // initialize state

    constructor() {
        super(dis);
    }

    setState(newState: Partial<typeof INITIAL_STATE>) {
        // If values haven't changed, there's nothing to do.
        // This only tries a shallow comparison, so unchanged objects will slip
        // through, but that's probably okay for now.
        let stateChanged = false;
        for (const key of Object.keys(newState)) {
            if (this.state[key] !== newState[key]) {
                stateChanged = true;
                break;
            }
        }
        if (!stateChanged) {
            return;
        }

        this.state = Object.assign(this.state, newState);
        this.__emitChange();
    }

    __onDispatch(payload) { // eslint-disable-line @typescript-eslint/naming-convention
        switch (payload.action) {
            // view_room:
            //      - room_alias:   '#somealias:matrix.org'
            //      - room_id:      '!roomid123:matrix.org'
            //      - event_id:     '$213456782:matrix.org'
            //      - event_offset: 100
            //      - highlighted:  true
            case 'view_room':
                this.viewRoom(payload);
                break;
            // for these events blank out the roomId as we are no longer in the RoomView
            case 'view_create_group':
            case 'view_welcome_page':
            case 'view_home_page':
            case 'view_my_groups':
            case 'view_group':
                this.setState({
                    roomId: null,
                    roomAlias: null,
                    viaServers: [],
                    wasContextSwitch: false,
                });
                break;
            case 'view_room_error':
                this.viewRoomError(payload);
                break;
            case 'will_join':
                this.setState({
                    joining: true,
                });
                break;
            case 'cancel_join':
                this.setState({
                    joining: false,
                });
                break;
            // join_room:
            //      - opts: options for joinRoom
            case Action.JoinRoom:
                this.joinRoom(payload);
                break;
            case Action.JoinRoomError:
                this.joinRoomError(payload);
                break;
            case Action.JoinRoomReady:
                this.setState({ shouldPeek: false });
                break;
            case 'on_client_not_viable':
            case 'on_logged_out':
                this.reset();
                break;
            case 'reply_to_event':
                // If currently viewed room does not match the room in which we wish to reply then change rooms
                // this can happen when performing a search across all rooms
                if (payload.event && payload.event.getRoomId() !== this.state.roomId) {
                    dis.dispatch({
                        action: 'view_room',
                        room_id: payload.event.getRoomId(),
                        replyingToEvent: payload.event,
                    });
                } else {
                    this.setState({
                        replyingToEvent: payload.event,
                    });
                }
                break;
            case 'open_room_settings': {
                // FIXME: Using an import will result in test failures
                const RoomSettingsDialog = sdk.getComponent("dialogs.RoomSettingsDialog");
                Modal.createTrackedDialog('Room settings', '', RoomSettingsDialog, {
                    roomId: payload.room_id || this.state.roomId,
                    initialTabId: payload.initial_tab_id,
                }, /*className=*/null, /*isPriority=*/false, /*isStatic=*/true);
                break;
            }
        }
    }

    private async viewRoom(payload: ActionPayload) {
        if (payload.room_id) {
            const newState = {
                roomId: payload.room_id,
                roomAlias: payload.room_alias,
                initialEventId: payload.event_id,
                isInitialEventHighlighted: payload.highlighted,
                roomLoading: false,
                roomLoadError: null,
                // should peek by default
                shouldPeek: payload.should_peek === undefined ? true : payload.should_peek,
                // have we sent a join request for this room and are waiting for a response?
                joining: payload.joining || false,
                // Reset replyingToEvent because we don't want cross-room because bad UX
                replyingToEvent: null,
                // pull the user out of Room Settings
                isEditingSettings: false,
                viaServers: payload.via_servers,
                wasContextSwitch: payload.context_switch,
            };

            // Allow being given an event to be replied to when switching rooms but sanity check its for this room
            if (payload.replyingToEvent && payload.replyingToEvent.getRoomId() === payload.room_id) {
                newState.replyingToEvent = payload.replyingToEvent;
            }

            this.setState(newState);

            if (payload.auto_join) {
                dis.dispatch({
                    ...payload,
                    action: Action.JoinRoom,
                    roomId: payload.room_id,
                });
            }
        } else if (payload.room_alias) {
            // Try the room alias to room ID navigation cache first to avoid
            // blocking room navigation on the homeserver.
            let roomId = getCachedRoomIDForAlias(payload.room_alias);
            if (!roomId) {
                // Room alias cache miss, so let's ask the homeserver. Resolve the alias
                // and then do a second dispatch with the room ID acquired.
                this.setState({
                    roomId: null,
                    initialEventId: null,
                    initialEventPixelOffset: null,
                    isInitialEventHighlighted: null,
                    roomAlias: payload.room_alias,
                    roomLoading: true,
                    roomLoadError: null,
                    viaServers: payload.via_servers,
                    wasContextSwitch: payload.context_switch,
                });
                try {
                    const result = await MatrixClientPeg.get().getRoomIdForAlias(payload.room_alias);
                    storeRoomAliasInCache(payload.room_alias, result.room_id);
                    roomId = result.room_id;
                } catch (err) {
                    console.error("RVS failed to get room id for alias: ", err);
                    dis.dispatch({
                        action: 'view_room_error',
                        room_id: null,
                        room_alias: payload.room_alias,
                        err,
                    });
                    return;
                }
            }

            dis.dispatch({
                action: 'view_room',
                room_id: roomId,
                event_id: payload.event_id,
                highlighted: payload.highlighted,
                room_alias: payload.room_alias,
                auto_join: payload.auto_join,
                oob_data: payload.oob_data,
                viaServers: payload.via_servers,
                wasContextSwitch: payload.context_switch,
            });
        }
    }

    private viewRoomError(payload: ActionPayload) {
        this.setState({
            roomId: payload.room_id,
            roomAlias: payload.room_alias,
            roomLoading: false,
            roomLoadError: payload.err,
        });
    }

    private async joinRoom(payload: ActionPayload) {
        const startTime = CountlyAnalytics.getTimestamp();
        this.setState({
            joining: true,
        });

        const cli = MatrixClientPeg.get();
        const address = this.state.roomAlias || this.state.roomId;
        const viaServers = this.state.viaServers || [];
        try {
            await retry<any, MatrixError>(() => cli.joinRoom(address, {
                viaServers,
                ...payload.opts,
            }), NUM_JOIN_RETRY, (err) => {
                // if we received a Gateway timeout then retry
                return err.httpStatus === 504;
            });
            CountlyAnalytics.instance.trackRoomJoin(startTime, this.state.roomId, payload._type);

            // We do *not* clear the 'joining' flag because the Room object and/or our 'joined' member event may not
            // have come down the sync stream yet, and that's the point at which we'd consider the user joined to the
            // room.
            dis.dispatch({
                action: Action.JoinRoomReady,
                roomId: this.state.roomId,
            });
        } catch (err) {
            dis.dispatch({
                action: Action.JoinRoomError,
                roomId: this.state.roomId,
                err: err,
            });
        }
    }

    private getInvitingUserId(roomId: string): string {
        const cli = MatrixClientPeg.get();
        const room = cli.getRoom(roomId);
        if (room && room.getMyMembership() === "invite") {
            const myMember = room.getMember(cli.getUserId());
            const inviteEvent = myMember ? myMember.events.member : null;
            return inviteEvent && inviteEvent.getSender();
        }
    }

    private joinRoomError(payload: ActionPayload) {
        this.setState({
            joining: false,
            joinError: payload.err,
        });
        const err = payload.err;
        let msg = err.message ? err.message : JSON.stringify(err);
        console.log("Failed to join room:", msg);

        if (err.name === "ConnectionError") {
            msg = _t("There was an error joining the room");
        } else if (err.errcode === 'M_INCOMPATIBLE_ROOM_VERSION') {
            msg = <div>
                { _t("Sorry, your homeserver is too old to participate in this room.") }<br />
                { _t("Please contact your homeserver administrator.") }
            </div>;
        } else if (err.httpStatus === 404) {
            const invitingUserId = this.getInvitingUserId(this.state.roomId);
            // only provide a better error message for invites
            if (invitingUserId) {
                // if the inviting user is on the same HS, there can only be one cause: they left.
                if (invitingUserId.endsWith(`:${MatrixClientPeg.get().getDomain()}`)) {
                    msg = _t("The person who invited you already left the room.");
                } else {
                    msg = _t("The person who invited you already left the room, or their server is offline.");
                }
            }
        }

        // FIXME: Using an import will result in test failures
        const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
        Modal.createTrackedDialog('Failed to join room', '', ErrorDialog, {
            title: _t("Failed to join room"),
            description: msg,
        });
    }

    public reset() {
        this.state = Object.assign({}, INITIAL_STATE);
    }

    // The room ID of the room currently being viewed
    public getRoomId() {
        return this.state.roomId;
    }

    // The event to scroll to when the room is first viewed
    public getInitialEventId() {
        return this.state.initialEventId;
    }

    // Whether to highlight the initial event
    public isInitialEventHighlighted() {
        return this.state.isInitialEventHighlighted;
    }

    // The room alias of the room (or null if not originally specified in view_room)
    public getRoomAlias() {
        return this.state.roomAlias;
    }

    // Whether the current room is loading (true whilst resolving an alias)
    public isRoomLoading() {
        return this.state.roomLoading;
    }

    // Any error that has occurred during loading
    public getRoomLoadError() {
        return this.state.roomLoadError;
    }

    // True if we're expecting the user to be joined to the room currently being
    // viewed. Note that this is left true after the join request has finished,
    // since we should still consider a join to be in progress until the room
    // & member events come down the sync.
    //
    // This flag remains true after the room has been sucessfully joined,
    // (this store doesn't listen for the appropriate member events)
    // so you should always observe the joined state from the member event
    // if a room object is present.
    // ie. The correct logic is:
    // if (room) {
    //     if (myMember.membership == 'joined') {
    //         // user is joined to the room
    //     } else {
    //         // Not joined
    //     }
    // } else {
    //     if (RoomViewStore.isJoining()) {
    //         // show spinner
    //     } else {
    //         // show join prompt
    //     }
    // }
    public isJoining() {
        return this.state.joining;
    }

    // Any error that has occurred during joining
    public getJoinError() {
        return this.state.joinError;
    }

    // The mxEvent if one is currently being replied to/quoted
    public getQuotingEvent() {
        return this.state.replyingToEvent;
    }

    public shouldPeek() {
        return this.state.shouldPeek;
    }

    public getWasContextSwitch() {
        return this.state.wasContextSwitch;
    }
}

let singletonRoomViewStore: RoomViewStore = null;
if (!singletonRoomViewStore) {
    singletonRoomViewStore = new RoomViewStore();
}
export default singletonRoomViewStore;
