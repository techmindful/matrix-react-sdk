/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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
import { ListIteratee, Many, sortBy, throttle } from "lodash";
import { EventType, RoomType } from "matrix-js-sdk/src/@types/event";
import { Room } from "matrix-js-sdk/src/models/room";
import { MatrixEvent } from "matrix-js-sdk/src/models/event";
import { IHierarchyRoom } from "matrix-js-sdk/src/@types/spaces";
import { JoinRule } from "matrix-js-sdk/src/@types/partials";
import { IRoomCapability } from "matrix-js-sdk/src/client";

import { AsyncStoreWithClient } from "./AsyncStoreWithClient";
import defaultDispatcher from "../dispatcher/dispatcher";
import { ActionPayload } from "../dispatcher/payloads";
import RoomListStore from "./room-list/RoomListStore";
import SettingsStore from "../settings/SettingsStore";
import DMRoomMap from "../utils/DMRoomMap";
import { FetchRoomFn } from "./notifications/ListNotificationState";
import { SpaceNotificationState } from "./notifications/SpaceNotificationState";
import { RoomNotificationStateStore } from "./notifications/RoomNotificationStateStore";
import { DefaultTagID } from "./room-list/models";
import { EnhancedMap, mapDiff } from "../utils/maps";
import { setHasDiff } from "../utils/sets";
import RoomViewStore from "./RoomViewStore";
import { Action } from "../dispatcher/actions";
import { arrayHasDiff, arrayHasOrderChange } from "../utils/arrays";
import { objectDiff } from "../utils/objects";
import { reorderLexicographically } from "../utils/stringOrderField";
import { TAG_ORDER } from "../components/views/rooms/RoomList";
import { shouldShowSpaceSettings } from "../utils/space";
import ToastStore from "./ToastStore";
import { _t } from "../languageHandler";
import GenericToast from "../components/views/toasts/GenericToast";
import Modal from "../Modal";
import InfoDialog from "../components/views/dialogs/InfoDialog";
import { SettingUpdatedPayload } from "../dispatcher/payloads/SettingUpdatedPayload";

type SpaceKey = string | symbol;

interface IState {}

const ACTIVE_SPACE_LS_KEY = "mx_active_space";

export const HOME_SPACE = Symbol("home-space");
export const SUGGESTED_ROOMS = Symbol("suggested-rooms");

export const UPDATE_TOP_LEVEL_SPACES = Symbol("top-level-spaces");
export const UPDATE_INVITED_SPACES = Symbol("invited-spaces");
export const UPDATE_SELECTED_SPACE = Symbol("selected-space");
export const UPDATE_HOME_BEHAVIOUR = Symbol("home-behaviour");
// Space Room ID/HOME_SPACE will be emitted when a Space's children change

export interface ISuggestedRoom extends IHierarchyRoom {
    viaServers: string[];
}

const MAX_SUGGESTED_ROOMS = 20;

// This setting causes the page to reload and can be costly if read frequently, so read it here only
const spacesEnabled = SettingsStore.getValue("feature_spaces");

const getSpaceContextKey = (space?: Room) => `mx_space_context_${space?.roomId || "HOME_SPACE"}`;

const partitionSpacesAndRooms = (arr: Room[]): [Room[], Room[]] => { // [spaces, rooms]
    return arr.reduce((result, room: Room) => {
        result[room.isSpaceRoom() ? 0 : 1].push(room);
        return result;
    }, [[], []]);
};

const validOrder = (order: string): string | undefined => {
    if (typeof order === "string" && order.length <= 50 && Array.from(order).every((c: string) => {
        const charCode = c.charCodeAt(0);
        return charCode >= 0x20 && charCode <= 0x7E;
    })) {
        return order;
    }
};

// For sorting space children using a validated `order`, `m.room.create`'s `origin_server_ts`, `room_id`
export const getChildOrder = (order: string, creationTs: number, roomId: string): Array<Many<ListIteratee<any>>> => {
    return [validOrder(order), creationTs, roomId];
};

const getRoomFn: FetchRoomFn = (room: Room) => {
    return RoomNotificationStateStore.instance.getRoomState(room);
};

export class SpaceStoreClass extends AsyncStoreWithClient<IState> {
    // The spaces representing the roots of the various tree-like hierarchies
    private rootSpaces: Room[] = [];
    // The list of rooms not present in any currently joined spaces
    private orphanedRooms = new Set<string>();
    // Map from room ID to set of spaces which list it as a child
    private parentMap = new EnhancedMap<string, Set<string>>();
    // Map from SpaceKey to SpaceNotificationState instance representing that space
    private notificationStateMap = new Map<SpaceKey, SpaceNotificationState>();
    // Map from space key to Set of room IDs that should be shown as part of that space's filter
    private spaceFilteredRooms = new Map<SpaceKey, Set<string>>();
    // The space currently selected in the Space Panel - if null then Home is selected
    private _activeSpace?: Room = null;
    private _suggestedRooms: ISuggestedRoom[] = [];
    private _invitedSpaces = new Set<Room>();
    private spaceOrderLocalEchoMap = new Map<string, string>();
    private _restrictedJoinRuleSupport?: IRoomCapability;
    private _allRoomsInHome: boolean = SettingsStore.getValue("Spaces.allRoomsInHome");

    constructor() {
        super(defaultDispatcher, {});

        SettingsStore.monitorSetting("Spaces.allRoomsInHome", null);
    }

    public get invitedSpaces(): Room[] {
        return Array.from(this._invitedSpaces);
    }

    public get spacePanelSpaces(): Room[] {
        return this.rootSpaces;
    }

    public get activeSpace(): Room | null {
        return this._activeSpace || null;
    }

    public get suggestedRooms(): ISuggestedRoom[] {
        return this._suggestedRooms;
    }

    public get allRoomsInHome(): boolean {
        return this._allRoomsInHome;
    }

    public async setActiveRoomInSpace(space: Room | null): Promise<void> {
        if (space && !space.isSpaceRoom()) return;
        if (space !== this.activeSpace) await this.setActiveSpace(space);

        if (space) {
            const roomId = this.getNotificationState(space.roomId).getFirstRoomWithNotifications();
            defaultDispatcher.dispatch({
                action: "view_room",
                room_id: roomId,
                context_switch: true,
            });
        } else {
            const lists = RoomListStore.instance.unfilteredLists;
            for (let i = 0; i < TAG_ORDER.length; i++) {
                const t = TAG_ORDER[i];
                const listRooms = lists[t];
                const unreadRoom = listRooms.find((r: Room) => {
                    if (this.showInHomeSpace(r)) {
                        const state = RoomNotificationStateStore.instance.getRoomState(r);
                        return state.isUnread;
                    }
                });
                if (unreadRoom) {
                    defaultDispatcher.dispatch({
                        action: "view_room",
                        room_id: unreadRoom.roomId,
                        context_switch: true,
                    });
                    break;
                }
            }
        }
    }

    public get restrictedJoinRuleSupport(): IRoomCapability {
        return this._restrictedJoinRuleSupport;
    }

    /**
     * Sets the active space, updates room list filters,
     * optionally switches the user's room back to where they were when they last viewed that space.
     * @param space which space to switch to.
     * @param contextSwitch whether to switch the user's context,
     * should not be done when the space switch is done implicitly due to another event like switching room.
     */
    public async setActiveSpace(space: Room | null, contextSwitch = true) {
        if (space === this.activeSpace || (space && !space.isSpaceRoom())) return;

        this._activeSpace = space;
        this.emit(UPDATE_SELECTED_SPACE, this.activeSpace);
        this.emit(SUGGESTED_ROOMS, this._suggestedRooms = []);

        if (contextSwitch) {
            // view last selected room from space
            const roomId = window.localStorage.getItem(getSpaceContextKey(this.activeSpace));

            // if the space being selected is an invite then always view that invite
            // else if the last viewed room in this space is joined then view that
            // else view space home or home depending on what is being clicked on
            if (space?.getMyMembership() !== "invite" &&
                this.matrixClient?.getRoom(roomId)?.getMyMembership() === "join" &&
                this.getSpaceFilteredRoomIds(space).has(roomId)
            ) {
                defaultDispatcher.dispatch({
                    action: "view_room",
                    room_id: roomId,
                    context_switch: true,
                });
            } else if (space) {
                defaultDispatcher.dispatch({
                    action: "view_room",
                    room_id: space.roomId,
                    context_switch: true,
                });
            } else {
                defaultDispatcher.dispatch({
                    action: "view_home_page",
                });
            }
        }

        // persist space selected
        if (space) {
            window.localStorage.setItem(ACTIVE_SPACE_LS_KEY, space.roomId);
        } else {
            window.localStorage.removeItem(ACTIVE_SPACE_LS_KEY);
        }

        // New in Spaces beta toast for Restricted Join Rule
        const lsKey = "mx_SpaceBeta_restrictedJoinRuleToastSeen";
        if (contextSwitch && space?.getJoinRule() === JoinRule.Invite && shouldShowSpaceSettings(space) &&
            space.getJoinedMemberCount() > 1 && !localStorage.getItem(lsKey)
            && this.restrictedJoinRuleSupport?.preferred
        ) {
            const toastKey = "restrictedjoinrule";
            ToastStore.sharedInstance().addOrReplaceToast({
                key: toastKey,
                title: _t("New in the Spaces beta"),
                props: {
                    description: _t("Help people in spaces to find and join private rooms"),
                    acceptLabel: _t("Learn more"),
                    onAccept: () => {
                        localStorage.setItem(lsKey, "true");
                        ToastStore.sharedInstance().dismissToast(toastKey);

                        Modal.createTrackedDialog("New in the Spaces beta", "restricted join rule", InfoDialog, {
                            title: _t("Help space members find private rooms"),
                            description: <>
                                <p>{ _t("To help space members find and join a private room, " +
                                    "go to that room's Security & Privacy settings.") }</p>

                                { /* Reuses classes from TabbedView for simplicity, non-interactive */ }
                                <div style={{ width: "190px" }}>
                                    <div className="mx_TabbedView_tabLabel">
                                        <span className="mx_TabbedView_maskedIcon mx_RoomSettingsDialog_settingsIcon" />
                                        <span className="mx_TabbedView_tabLabel_text">{ _t("General") }</span>
                                    </div>
                                    <div className="mx_TabbedView_tabLabel mx_TabbedView_tabLabel_active">
                                        <span className="mx_TabbedView_maskedIcon mx_RoomSettingsDialog_securityIcon" />
                                        <span className="mx_TabbedView_tabLabel_text">{ _t("Security & Privacy") }</span>
                                    </div>
                                    <div className="mx_TabbedView_tabLabel">
                                        <span className="mx_TabbedView_maskedIcon mx_RoomSettingsDialog_rolesIcon" />
                                        <span className="mx_TabbedView_tabLabel_text">{ _t("Roles & Permissions") }</span>
                                    </div>
                                </div>

                                <p>{ _t("This makes it easy for rooms to stay private to a space, " +
                                    "while letting people in the space find and join them. " +
                                    "All new rooms in a space will have this option available.") }</p>
                            </>,
                            button: _t("OK"),
                            hasCloseButton: false,
                            fixedWidth: true,
                        });
                    },
                    rejectLabel: _t("Skip"),
                    onReject: () => {
                        localStorage.setItem(lsKey, "true");
                        ToastStore.sharedInstance().dismissToast(toastKey);
                    },
                },
                component: GenericToast,
                priority: 35,
            });
        }

        if (space) {
            const suggestedRooms = await this.fetchSuggestedRooms(space);
            if (this._activeSpace === space) {
                this._suggestedRooms = suggestedRooms;
                this.emit(SUGGESTED_ROOMS, this._suggestedRooms);
            }
        }
    }

    public fetchSuggestedRooms = async (space: Room, limit = MAX_SUGGESTED_ROOMS): Promise<ISuggestedRoom[]> => {
        try {
            const { rooms } = await this.matrixClient.getRoomHierarchy(space.roomId, limit, 1, true);

            const viaMap = new EnhancedMap<string, Set<string>>();
            rooms.forEach(room => {
                room.children_state.forEach(ev => {
                    if (ev.type === EventType.SpaceChild && ev.content.via?.length) {
                        ev.content.via.forEach(via => {
                            viaMap.getOrCreate(ev.state_key, new Set()).add(via);
                        });
                    }
                });
            });

            return rooms.filter(roomInfo => {
                return roomInfo.room_type !== RoomType.Space
                    && this.matrixClient.getRoom(roomInfo.room_id)?.getMyMembership() !== "join";
            }).map(roomInfo => ({
                ...roomInfo,
                viaServers: Array.from(viaMap.get(roomInfo.room_id) || []),
            }));
        } catch (e) {
            console.error(e);
        }
        return [];
    };

    public addRoomToSpace(space: Room, roomId: string, via: string[], suggested = false, autoJoin = false) {
        return this.matrixClient.sendStateEvent(space.roomId, EventType.SpaceChild, {
            via,
            suggested,
            auto_join: autoJoin,
        }, roomId);
    }

    public getChildren(spaceId: string): Room[] {
        const room = this.matrixClient?.getRoom(spaceId);
        const childEvents = room?.currentState.getStateEvents(EventType.SpaceChild).filter(ev => ev.getContent()?.via);
        return sortBy(childEvents, ev => {
            const roomId = ev.getStateKey();
            const childRoom = this.matrixClient?.getRoom(roomId);
            const createTs = childRoom?.currentState.getStateEvents(EventType.RoomCreate, "")?.getTs();
            return getChildOrder(ev.getContent().order, createTs, roomId);
        }).map(ev => {
            return this.matrixClient.getRoom(ev.getStateKey());
        }).filter(room => {
            return room?.getMyMembership() === "join" || room?.getMyMembership() === "invite";
        }) || [];
    }

    public getChildRooms(spaceId: string): Room[] {
        return this.getChildren(spaceId).filter(r => !r.isSpaceRoom());
    }

    public getChildSpaces(spaceId: string): Room[] {
        // don't show invited subspaces as they surface at the top level for better visibility
        return this.getChildren(spaceId).filter(r => r.isSpaceRoom() && r.getMyMembership() === "join");
    }

    public getParents(roomId: string, canonicalOnly = false): Room[] {
        const room = this.matrixClient?.getRoom(roomId);
        return room?.currentState.getStateEvents(EventType.SpaceParent)
            .filter(ev => {
                const content = ev.getContent();
                if (!content?.via?.length) return false;
                // TODO apply permissions check to verify that the parent mapping is valid
                if (canonicalOnly && !content?.canonical) return false;
                return true;
            })
            .map(ev => this.matrixClient.getRoom(ev.getStateKey()))
            .filter(Boolean) || [];
    }

    public getCanonicalParent(roomId: string): Room | null {
        const parents = this.getParents(roomId, true);
        return sortBy(parents, r => r.roomId)?.[0] || null;
    }

    public getKnownParents(roomId: string): Set<string> {
        return this.parentMap.get(roomId) || new Set();
    }

    public getSpaceFilteredRoomIds = (space: Room | null): Set<string> => {
        if (!space && this.allRoomsInHome) {
            return new Set(this.matrixClient.getVisibleRooms().map(r => r.roomId));
        }
        return this.spaceFilteredRooms.get(space?.roomId || HOME_SPACE) || new Set();
    };

    private rebuild = throttle(() => {
        const [visibleSpaces, visibleRooms] = partitionSpacesAndRooms(this.matrixClient.getVisibleRooms());
        const [joinedSpaces, invitedSpaces] = visibleSpaces.reduce((arr, s) => {
            if (s.getMyMembership() === "join") {
                arr[0].push(s);
            } else if (s.getMyMembership() === "invite") {
                arr[1].push(s);
            }
            return arr;
        }, [[], []]);

        // exclude invited spaces from unseenChildren as they will be forcibly shown at the top level of the treeview
        const unseenChildren = new Set<Room>([...visibleRooms, ...joinedSpaces]);
        const backrefs = new EnhancedMap<string, Set<string>>();

        // Sort spaces by room ID to force the cycle breaking to be deterministic
        const spaces = sortBy(joinedSpaces, space => space.roomId);

        // TODO handle cleaning up links when a Space is removed
        spaces.forEach(space => {
            const children = this.getChildren(space.roomId);
            children.forEach(child => {
                unseenChildren.delete(child);

                backrefs.getOrCreate(child.roomId, new Set()).add(space.roomId);
            });
        });

        const [rootSpaces, orphanedRooms] = partitionSpacesAndRooms(Array.from(unseenChildren));

        // somewhat algorithm to handle full-cycles
        const detachedNodes = new Set<Room>(spaces);

        const markTreeChildren = (rootSpace: Room, unseen: Set<Room>) => {
            const stack = [rootSpace];
            while (stack.length) {
                const op = stack.pop();
                unseen.delete(op);
                this.getChildSpaces(op.roomId).forEach(space => {
                    if (unseen.has(space)) {
                        stack.push(space);
                    }
                });
            }
        };

        rootSpaces.forEach(rootSpace => {
            markTreeChildren(rootSpace, detachedNodes);
        });

        // Handle spaces forming fully cyclical relationships.
        // In order, assume each detachedNode is a root unless it has already
        // been claimed as the child of prior detached node.
        // Work from a copy of the detachedNodes set as it will be mutated as part of this operation.
        Array.from(detachedNodes).forEach(detachedNode => {
            if (!detachedNodes.has(detachedNode)) return;
            // declare this detached node a new root, find its children, without ever looping back to it
            detachedNodes.delete(detachedNode);
            rootSpaces.push(detachedNode);
            markTreeChildren(detachedNode, detachedNodes);

            // TODO only consider a detached node a root space if it has no *parents other than the ones forming cycles
        });

        // TODO neither of these handle an A->B->C->A with an additional C->D
        // detachedNodes.forEach(space => {
        //     rootSpaces.push(space);
        // });

        this.orphanedRooms = new Set(orphanedRooms.map(r => r.roomId));
        this.rootSpaces = this.sortRootSpaces(rootSpaces);
        this.parentMap = backrefs;

        // if the currently selected space no longer exists, remove its selection
        if (this._activeSpace && detachedNodes.has(this._activeSpace)) {
            this.setActiveSpace(null, false);
        }

        this.onRoomsUpdate(); // TODO only do this if a change has happened
        this.emit(UPDATE_TOP_LEVEL_SPACES, this.spacePanelSpaces);

        // build initial state of invited spaces as we would have missed the emitted events about the room at launch
        this._invitedSpaces = new Set(this.sortRootSpaces(invitedSpaces));
        this.emit(UPDATE_INVITED_SPACES, this.invitedSpaces);
    }, 100, { trailing: true, leading: true });

    private onSpaceUpdate = () => {
        this.rebuild();
    };

    private showInHomeSpace = (room: Room) => {
        if (this.allRoomsInHome) return true;
        if (room.isSpaceRoom()) return false;
        return !this.parentMap.get(room.roomId)?.size // put all orphaned rooms in the Home Space
            || DMRoomMap.shared().getUserIdForRoomId(room.roomId) // put all DMs in the Home Space
            || RoomListStore.instance.getTagsForRoom(room).includes(DefaultTagID.Favourite); // show all favourites
    };

    // Update a given room due to its tag changing (e.g DM-ness or Fav-ness)
    // This can only change whether it shows up in the HOME_SPACE or not
    private onRoomUpdate = (room: Room) => {
        if (this.showInHomeSpace(room)) {
            this.spaceFilteredRooms.get(HOME_SPACE)?.add(room.roomId);
            this.emit(HOME_SPACE);
        } else if (!this.orphanedRooms.has(room.roomId)) {
            this.spaceFilteredRooms.get(HOME_SPACE)?.delete(room.roomId);
            this.emit(HOME_SPACE);
        }
    };

    private onSpaceMembersChange = (ev: MatrixEvent) => {
        // skip this update if we do not have a DM with this user
        if (DMRoomMap.shared().getDMRoomsForUserId(ev.getStateKey()).length < 1) return;
        this.onRoomsUpdate();
    };

    private onRoomsUpdate = throttle(() => {
        // TODO resolve some updates as deltas
        const visibleRooms = this.matrixClient.getVisibleRooms();

        const oldFilteredRooms = this.spaceFilteredRooms;
        this.spaceFilteredRooms = new Map();

        if (!this.allRoomsInHome) {
            // put all room invites in the Home Space
            const invites = visibleRooms.filter(r => !r.isSpaceRoom() && r.getMyMembership() === "invite");
            this.spaceFilteredRooms.set(HOME_SPACE, new Set<string>(invites.map(room => room.roomId)));

            visibleRooms.forEach(room => {
                if (this.showInHomeSpace(room)) {
                    this.spaceFilteredRooms.get(HOME_SPACE).add(room.roomId);
                }
            });
        }

        this.rootSpaces.forEach(s => {
            // traverse each space tree in DFS to build up the supersets as you go up,
            // reusing results from like subtrees.
            const fn = (spaceId: string, parentPath: Set<string>): Set<string> => {
                if (parentPath.has(spaceId)) return; // prevent cycles

                // reuse existing results if multiple similar branches exist
                if (this.spaceFilteredRooms.has(spaceId)) {
                    return this.spaceFilteredRooms.get(spaceId);
                }

                const [childSpaces, childRooms] = partitionSpacesAndRooms(this.getChildren(spaceId));
                const roomIds = new Set(childRooms.map(r => r.roomId));
                const space = this.matrixClient?.getRoom(spaceId);

                // Add relevant DMs
                space?.getMembers().forEach(member => {
                    if (member.membership !== "join" && member.membership !== "invite") return;
                    DMRoomMap.shared().getDMRoomsForUserId(member.userId).forEach(roomId => {
                        roomIds.add(roomId);
                    });
                });

                const newPath = new Set(parentPath).add(spaceId);
                childSpaces.forEach(childSpace => {
                    fn(childSpace.roomId, newPath)?.forEach(roomId => {
                        roomIds.add(roomId);
                    });
                });
                this.spaceFilteredRooms.set(spaceId, roomIds);
                return roomIds;
            };

            fn(s.roomId, new Set());
        });

        const diff = mapDiff(oldFilteredRooms, this.spaceFilteredRooms);
        // filter out keys which changed by reference only by checking whether the sets differ
        const changed = diff.changed.filter(k => setHasDiff(oldFilteredRooms.get(k), this.spaceFilteredRooms.get(k)));
        [...diff.added, ...diff.removed, ...changed].forEach(k => {
            this.emit(k);
        });

        this.spaceFilteredRooms.forEach((roomIds, s) => {
            if (this.allRoomsInHome && s === HOME_SPACE) return; // we'll be using the global notification state, skip

            // Update NotificationStates
            this.getNotificationState(s).setRooms(visibleRooms.filter(room => {
                if (!roomIds.has(room.roomId)) return false;

                if (DMRoomMap.shared().getUserIdForRoomId(room.roomId)) {
                    return s === HOME_SPACE;
                }

                return true;
            }));
        });
    }, 100, { trailing: true, leading: true });

    private switchToRelatedSpace = (roomId: string) => {
        if (this.suggestedRooms.find(r => r.room_id === roomId)) return;

        let parent = this.getCanonicalParent(roomId);
        if (!parent) {
            parent = this.rootSpaces.find(s => this.spaceFilteredRooms.get(s.roomId)?.has(roomId));
        }
        if (!parent) {
            const parentIds = Array.from(this.parentMap.get(roomId) || []);
            for (const parentId of parentIds) {
                const room = this.matrixClient.getRoom(parentId);
                if (room) {
                    parent = room;
                    break;
                }
            }
        }

        // don't trigger a context switch when we are switching a space to match the chosen room
        this.setActiveSpace(parent || null, false);
    };

    private onRoom = (room: Room, newMembership?: string, oldMembership?: string) => {
        const membership = newMembership || room.getMyMembership();

        if (!room.isSpaceRoom()) {
            // this.onRoomUpdate(room);
            this.onRoomsUpdate();

            if (membership === "join") {
                // the user just joined a room, remove it from the suggested list if it was there
                const numSuggestedRooms = this._suggestedRooms.length;
                this._suggestedRooms = this._suggestedRooms.filter(r => r.room_id !== room.roomId);
                if (numSuggestedRooms !== this._suggestedRooms.length) {
                    this.emit(SUGGESTED_ROOMS, this._suggestedRooms);
                }

                // if the room currently being viewed was just joined then switch to its related space
                if (newMembership === "join" && room.roomId === RoomViewStore.getRoomId()) {
                    this.switchToRelatedSpace(room.roomId);
                }
            }
            return;
        }

        // Space
        if (membership === "invite") {
            this._invitedSpaces.add(room);
            this.emit(UPDATE_INVITED_SPACES, this.invitedSpaces);
        } else if (oldMembership === "invite" && membership !== "join") {
            this._invitedSpaces.delete(room);
            this.emit(UPDATE_INVITED_SPACES, this.invitedSpaces);
        } else {
            this.onSpaceUpdate();
            this.emit(room.roomId);
        }

        if (membership === "join" && room.roomId === RoomViewStore.getRoomId()) {
            // if the user was looking at the space and then joined: select that space
            this.setActiveSpace(room, false);
        }
    };

    private notifyIfOrderChanged(): void {
        const rootSpaces = this.sortRootSpaces(this.rootSpaces);
        if (arrayHasOrderChange(this.rootSpaces, rootSpaces)) {
            this.rootSpaces = rootSpaces;
            this.emit(UPDATE_TOP_LEVEL_SPACES, this.spacePanelSpaces);
        }
    }

    private onRoomState = (ev: MatrixEvent) => {
        const room = this.matrixClient.getRoom(ev.getRoomId());
        if (!room) return;

        switch (ev.getType()) {
            case EventType.SpaceChild:
                if (room.isSpaceRoom()) {
                    this.onSpaceUpdate();
                    this.emit(room.roomId);
                }
                break;

            case EventType.SpaceParent:
                // TODO rebuild the space parent and not the room - check permissions?
                // TODO confirm this after implementing parenting behaviour
                if (room.isSpaceRoom()) {
                    this.onSpaceUpdate();
                } else if (!this.allRoomsInHome) {
                    this.onRoomUpdate(room);
                }
                this.emit(room.roomId);
                break;

            case EventType.RoomMember:
                if (room.isSpaceRoom()) {
                    this.onSpaceMembersChange(ev);
                }
                break;
        }
    };

    private onRoomAccountData = (ev: MatrixEvent, room: Room, lastEv?: MatrixEvent) => {
        if (!room.isSpaceRoom()) return;

        if (ev.getType() === EventType.SpaceOrder) {
            this.spaceOrderLocalEchoMap.delete(room.roomId); // clear any local echo
            const order = ev.getContent()?.order;
            const lastOrder = lastEv?.getContent()?.order;
            if (order !== lastOrder) {
                this.notifyIfOrderChanged();
            }
        } else if (ev.getType() === EventType.Tag && !this.allRoomsInHome) {
            // If the room was in favourites and now isn't or the opposite then update its position in the trees
            const oldTags = lastEv?.getContent()?.tags || {};
            const newTags = ev.getContent()?.tags || {};
            if (!!oldTags[DefaultTagID.Favourite] !== !!newTags[DefaultTagID.Favourite]) {
                this.onRoomUpdate(room);
            }
        }
    };

    private onAccountData = (ev: MatrixEvent, lastEvent: MatrixEvent) => {
        if (!this.allRoomsInHome && ev.getType() === EventType.Direct) {
            const lastContent = lastEvent.getContent();
            const content = ev.getContent();

            const diff = objectDiff<Record<string, string[]>>(lastContent, content);
            // filter out keys which changed by reference only by checking whether the sets differ
            const changed = diff.changed.filter(k => arrayHasDiff(lastContent[k], content[k]));
            // DM tag changes, refresh relevant rooms
            new Set([...diff.added, ...diff.removed, ...changed]).forEach(roomId => {
                const room = this.matrixClient?.getRoom(roomId);
                if (room) {
                    this.onRoomUpdate(room);
                }
            });
        }
    };

    protected async reset() {
        this.rootSpaces = [];
        this.orphanedRooms = new Set();
        this.parentMap = new EnhancedMap();
        this.notificationStateMap = new Map();
        this.spaceFilteredRooms = new Map();
        this._activeSpace = null;
        this._suggestedRooms = [];
        this._invitedSpaces = new Set();
    }

    protected async onNotReady() {
        if (!SpaceStore.spacesEnabled) return;
        if (this.matrixClient) {
            this.matrixClient.removeListener("Room", this.onRoom);
            this.matrixClient.removeListener("Room.myMembership", this.onRoom);
            this.matrixClient.removeListener("Room.accountData", this.onRoomAccountData);
            this.matrixClient.removeListener("RoomState.events", this.onRoomState);
            this.matrixClient.removeListener("accountData", this.onAccountData);
        }
        await this.reset();
    }

    protected async onReady() {
        if (!spacesEnabled) return;
        this.matrixClient.on("Room", this.onRoom);
        this.matrixClient.on("Room.myMembership", this.onRoom);
        this.matrixClient.on("Room.accountData", this.onRoomAccountData);
        this.matrixClient.on("RoomState.events", this.onRoomState);
        this.matrixClient.on("accountData", this.onAccountData);

        this.matrixClient.getCapabilities().then(capabilities => {
            this._restrictedJoinRuleSupport = capabilities
                ?.["m.room_versions"]?.["org.matrix.msc3244.room_capabilities"]?.["restricted"];
        });

        await this.onSpaceUpdate(); // trigger an initial update

        // restore selected state from last session if any and still valid
        const lastSpaceId = window.localStorage.getItem(ACTIVE_SPACE_LS_KEY);
        if (lastSpaceId) {
            this.setActiveSpace(this.matrixClient.getRoom(lastSpaceId));
        }
    }

    protected async onAction(payload: ActionPayload) {
        if (!spacesEnabled) return;
        switch (payload.action) {
            case "view_room": {
                // Don't auto-switch rooms when reacting to a context-switch
                // as this is not helpful and can create loops of rooms/space switching
                if (payload.context_switch) break;

                const roomId = payload.room_id;
                const room = this.matrixClient?.getRoom(roomId);
                if (room?.isSpaceRoom()) {
                    // Don't context switch when navigating to the space room
                    // as it will cause you to end up in the wrong room
                    this.setActiveSpace(room, false);
                } else if (
                    (!this.allRoomsInHome || this.activeSpace) &&
                    !this.getSpaceFilteredRoomIds(this.activeSpace).has(roomId)
                ) {
                    this.switchToRelatedSpace(roomId);
                }

                // Persist last viewed room from a space
                // we don't await setActiveSpace above as we only care about this.activeSpace being up to date
                // synchronously for the below code - everything else can and should be async.
                window.localStorage.setItem(getSpaceContextKey(this.activeSpace), payload.room_id);
                break;
            }

            case "after_leave_room":
                if (this._activeSpace && payload.room_id === this._activeSpace.roomId) {
                    this.setActiveSpace(null, false);
                }
                break;

            case Action.SwitchSpace:
                if (payload.num === 0) {
                    this.setActiveSpace(null);
                } else if (this.spacePanelSpaces.length >= payload.num) {
                    this.setActiveSpace(this.spacePanelSpaces[payload.num - 1]);
                }
                break;

            case Action.SettingUpdated: {
                const settingUpdatedPayload = payload as SettingUpdatedPayload;
                if (settingUpdatedPayload.settingName === "Spaces.allRoomsInHome") {
                    const newValue = SettingsStore.getValue("Spaces.allRoomsInHome");
                    if (this.allRoomsInHome !== newValue) {
                        this._allRoomsInHome = newValue;
                        this.emit(UPDATE_HOME_BEHAVIOUR, this.allRoomsInHome);
                        this.rebuild(); // rebuild everything
                    }
                }
                break;
            }
        }
    }

    public getNotificationState(key: SpaceKey): SpaceNotificationState {
        if (this.notificationStateMap.has(key)) {
            return this.notificationStateMap.get(key);
        }

        const state = new SpaceNotificationState(key, getRoomFn);
        this.notificationStateMap.set(key, state);
        return state;
    }

    // traverse space tree with DFS calling fn on each space including the given root one,
    // if includeRooms is true then fn will be called on each leaf room, if it is present in multiple sub-spaces
    // then fn will be called with it multiple times.
    public traverseSpace(
        spaceId: string,
        fn: (roomId: string) => void,
        includeRooms = false,
        parentPath?: Set<string>,
    ) {
        if (parentPath && parentPath.has(spaceId)) return; // prevent cycles

        fn(spaceId);

        const newPath = new Set(parentPath).add(spaceId);
        const [childSpaces, childRooms] = partitionSpacesAndRooms(this.getChildren(spaceId));

        if (includeRooms) {
            childRooms.forEach(r => fn(r.roomId));
        }
        childSpaces.forEach(s => this.traverseSpace(s.roomId, fn, includeRooms, newPath));
    }

    private getSpaceTagOrdering = (space: Room): string | undefined => {
        if (this.spaceOrderLocalEchoMap.has(space.roomId)) return this.spaceOrderLocalEchoMap.get(space.roomId);
        return validOrder(space.getAccountData(EventType.SpaceOrder)?.getContent()?.order);
    };

    private sortRootSpaces(spaces: Room[]): Room[] {
        return sortBy(spaces, [this.getSpaceTagOrdering, "roomId"]);
    }

    private async setRootSpaceOrder(space: Room, order: string): Promise<void> {
        this.spaceOrderLocalEchoMap.set(space.roomId, order);
        try {
            await this.matrixClient.setRoomAccountData(space.roomId, EventType.SpaceOrder, { order });
        } catch (e) {
            console.warn("Failed to set root space order", e);
            if (this.spaceOrderLocalEchoMap.get(space.roomId) === order) {
                this.spaceOrderLocalEchoMap.delete(space.roomId);
            }
        }
    }

    public moveRootSpace(fromIndex: number, toIndex: number): void {
        const currentOrders = this.rootSpaces.map(this.getSpaceTagOrdering);
        const changes = reorderLexicographically(currentOrders, fromIndex, toIndex);

        changes.forEach(({ index, order }) => {
            this.setRootSpaceOrder(this.rootSpaces[index], order);
        });

        this.notifyIfOrderChanged();
    }
}

export default class SpaceStore {
    public static spacesEnabled = spacesEnabled;

    private static internalInstance = new SpaceStoreClass();

    public static get instance(): SpaceStoreClass {
        return SpaceStore.internalInstance;
    }
}

window.mxSpaceStore = SpaceStore.instance;
