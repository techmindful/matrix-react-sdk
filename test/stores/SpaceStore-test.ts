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

import { EventEmitter } from "events";
import { EventType } from "matrix-js-sdk/src/@types/event";
import { RoomMember } from "matrix-js-sdk/src/models/room-member";

import "./SpaceStore-setup"; // enable space lab
import "../skinned-sdk"; // Must be first for skinning to work
import SpaceStore, {
    UPDATE_HOME_BEHAVIOUR,
    UPDATE_INVITED_SPACES,
    UPDATE_SELECTED_SPACE,
    UPDATE_TOP_LEVEL_SPACES,
} from "../../src/stores/SpaceStore";
import * as testUtils from "../utils/test-utils";
import { mkEvent, stubClient } from "../test-utils";
import DMRoomMap from "../../src/utils/DMRoomMap";
import { MatrixClientPeg } from "../../src/MatrixClientPeg";
import defaultDispatcher from "../../src/dispatcher/dispatcher";
import SettingsStore from "../../src/settings/SettingsStore";
import { SettingLevel } from "../../src/settings/SettingLevel";

jest.useFakeTimers();

const testUserId = "@test:user";

const getUserIdForRoomId = jest.fn();
const getDMRoomsForUserId = jest.fn();
// @ts-ignore
DMRoomMap.sharedInstance = { getUserIdForRoomId, getDMRoomsForUserId };

const fav1 = "!fav1:server";
const fav2 = "!fav2:server";
const fav3 = "!fav3:server";
const dm1 = "!dm1:server";
const dm1Partner = new RoomMember(dm1, "@dm1Partner:server");
dm1Partner.membership = "join";
const dm2 = "!dm2:server";
const dm2Partner = new RoomMember(dm2, "@dm2Partner:server");
dm2Partner.membership = "join";
const dm3 = "!dm3:server";
const dm3Partner = new RoomMember(dm3, "@dm3Partner:server");
dm3Partner.membership = "join";
const orphan1 = "!orphan1:server";
const orphan2 = "!orphan2:server";
const invite1 = "!invite1:server";
const invite2 = "!invite2:server";
const room1 = "!room1:server";
const room2 = "!room2:server";
const room3 = "!room3:server";
const space1 = "!space1:server";
const space2 = "!space2:server";
const space3 = "!space3:server";

describe("SpaceStore", () => {
    stubClient();
    const store = SpaceStore.instance;
    const client = MatrixClientPeg.get();

    let rooms = [];
    const mkRoom = (roomId: string) => testUtils.mkRoom(client, roomId, rooms);
    const mkSpace = (spaceId: string, children: string[] = []) => testUtils.mkSpace(client, spaceId, rooms, children);
    const viewRoom = roomId => defaultDispatcher.dispatch({ action: "view_room", room_id: roomId }, true);

    const run = async () => {
        client.getRoom.mockImplementation(roomId => rooms.find(room => room.roomId === roomId));
        await testUtils.setupAsyncStoreWithClient(store, client);
        jest.runAllTimers();
    };

    const setShowAllRooms = async (value: boolean) => {
        if (store.allRoomsInHome === value) return;
        const emitProm = testUtils.emitPromise(store, UPDATE_HOME_BEHAVIOUR);
        await SettingsStore.setValue("Spaces.allRoomsInHome", null, SettingLevel.DEVICE, value);
        jest.runAllTimers(); // run async dispatch
        await emitProm;
    };

    beforeEach(() => {
        jest.runAllTimers(); // run async dispatch
        client.getVisibleRooms.mockReturnValue(rooms = []);
    });
    afterEach(async () => {
        await testUtils.resetAsyncStoreWithClient(store);
    });

    describe("static hierarchy resolution tests", () => {
        it("handles no spaces", async () => {
            await run();

            expect(store.spacePanelSpaces).toStrictEqual([]);
            expect(store.invitedSpaces).toStrictEqual([]);
        });

        it("handles 3 joined top level spaces", async () => {
            mkSpace("!space1:server");
            mkSpace("!space2:server");
            mkSpace("!space3:server");
            await run();

            expect(store.spacePanelSpaces.sort()).toStrictEqual(client.getVisibleRooms().sort());
            expect(store.invitedSpaces).toStrictEqual([]);
        });

        it("handles a basic hierarchy", async () => {
            mkSpace("!space1:server");
            mkSpace("!space2:server");
            mkSpace("!company:server", [
                mkSpace("!company_dept1:server", [
                    mkSpace("!company_dept1_group1:server").roomId,
                ]).roomId,
                mkSpace("!company_dept2:server").roomId,
            ]);
            await run();

            expect(store.spacePanelSpaces.map(r => r.roomId).sort()).toStrictEqual([
                "!space1:server",
                "!space2:server",
                "!company:server",
            ].sort());
            expect(store.invitedSpaces).toStrictEqual([]);

            expect(store.getChildRooms("!space1:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!space1:server")).toStrictEqual([]);
            expect(store.getChildRooms("!space2:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!space2:server")).toStrictEqual([]);
            expect(store.getChildRooms("!company:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!company:server")).toStrictEqual([
                client.getRoom("!company_dept1:server"),
                client.getRoom("!company_dept2:server"),
            ]);
            expect(store.getChildRooms("!company_dept1:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!company_dept1:server")).toStrictEqual([
                client.getRoom("!company_dept1_group1:server"),
            ]);
            expect(store.getChildRooms("!company_dept1_group1:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!company_dept1_group1:server")).toStrictEqual([]);
            expect(store.getChildRooms("!company_dept2:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!company_dept2:server")).toStrictEqual([]);
        });

        it("handles a sub-space existing in multiple places in the space tree", async () => {
            const subspace = mkSpace("!subspace:server");
            mkSpace("!space1:server");
            mkSpace("!space2:server");
            mkSpace("!company:server", [
                mkSpace("!company_dept1:server", [
                    mkSpace("!company_dept1_group1:server", [subspace.roomId]).roomId,
                ]).roomId,
                mkSpace("!company_dept2:server", [subspace.roomId]).roomId,
                subspace.roomId,
            ]);
            await run();

            expect(store.spacePanelSpaces.map(r => r.roomId).sort()).toStrictEqual([
                "!space1:server",
                "!space2:server",
                "!company:server",
            ].sort());
            expect(store.invitedSpaces).toStrictEqual([]);

            expect(store.getChildRooms("!space1:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!space1:server")).toStrictEqual([]);
            expect(store.getChildRooms("!space2:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!space2:server")).toStrictEqual([]);
            expect(store.getChildRooms("!company:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!company:server")).toStrictEqual([
                client.getRoom("!company_dept1:server"),
                client.getRoom("!company_dept2:server"),
                subspace,
            ]);
            expect(store.getChildRooms("!company_dept1:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!company_dept1:server")).toStrictEqual([
                client.getRoom("!company_dept1_group1:server"),
            ]);
            expect(store.getChildRooms("!company_dept1_group1:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!company_dept1_group1:server")).toStrictEqual([subspace]);
            expect(store.getChildRooms("!company_dept2:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!company_dept2:server")).toStrictEqual([subspace]);
        });

        it("handles full cycles", async () => {
            mkSpace("!a:server", [
                mkSpace("!b:server", [
                    mkSpace("!c:server", [
                        "!a:server",
                    ]).roomId,
                ]).roomId,
            ]);
            await run();

            expect(store.spacePanelSpaces.map(r => r.roomId)).toStrictEqual(["!a:server"]);
            expect(store.invitedSpaces).toStrictEqual([]);

            expect(store.getChildRooms("!a:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!a:server")).toStrictEqual([client.getRoom("!b:server")]);
            expect(store.getChildRooms("!b:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!b:server")).toStrictEqual([client.getRoom("!c:server")]);
            expect(store.getChildRooms("!c:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!c:server")).toStrictEqual([client.getRoom("!a:server")]);
        });

        it("handles partial cycles", async () => {
            mkSpace("!b:server", [
                mkSpace("!a:server", [
                    mkSpace("!c:server", [
                        "!a:server",
                    ]).roomId,
                ]).roomId,
            ]);
            await run();

            expect(store.spacePanelSpaces.map(r => r.roomId)).toStrictEqual(["!b:server"]);
            expect(store.invitedSpaces).toStrictEqual([]);

            expect(store.getChildRooms("!b:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!b:server")).toStrictEqual([client.getRoom("!a:server")]);
            expect(store.getChildRooms("!a:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!a:server")).toStrictEqual([client.getRoom("!c:server")]);
            expect(store.getChildRooms("!c:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!c:server")).toStrictEqual([client.getRoom("!a:server")]);
        });

        it("handles partial cycles with additional spaces coming off them", async () => {
            // TODO this test should be failing right now
            mkSpace("!a:server", [
                mkSpace("!b:server", [
                    mkSpace("!c:server", [
                        "!a:server",
                        mkSpace("!d:server").roomId,
                    ]).roomId,
                ]).roomId,
            ]);
            await run();

            expect(store.spacePanelSpaces.map(r => r.roomId)).toStrictEqual(["!a:server"]);
            expect(store.invitedSpaces).toStrictEqual([]);

            expect(store.getChildRooms("!a:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!a:server")).toStrictEqual([client.getRoom("!b:server")]);
            expect(store.getChildRooms("!b:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!b:server")).toStrictEqual([client.getRoom("!c:server")]);
            expect(store.getChildRooms("!c:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!c:server")).toStrictEqual([
                client.getRoom("!a:server"),
                client.getRoom("!d:server"),
            ]);
            expect(store.getChildRooms("!d:server")).toStrictEqual([]);
            expect(store.getChildSpaces("!d:server")).toStrictEqual([]);
        });

        it("invite to a subspace is only shown at the top level", async () => {
            mkSpace(invite1).getMyMembership.mockReturnValue("invite");
            mkSpace(space1, [invite1]);
            await run();

            expect(store.spacePanelSpaces).toStrictEqual([client.getRoom(space1)]);
            expect(store.getChildSpaces(space1)).toStrictEqual([]);
            expect(store.getChildRooms(space1)).toStrictEqual([]);
            expect(store.invitedSpaces).toStrictEqual([client.getRoom(invite1)]);
        });

        describe("test fixture 1", () => {
            beforeEach(async () => {
                [fav1, fav2, fav3, dm1, dm2, dm3, orphan1, orphan2, invite1, invite2, room1].forEach(mkRoom);
                mkSpace(space1, [fav1, room1]);
                mkSpace(space2, [fav1, fav2, fav3, room1]);
                mkSpace(space3, [invite2]);

                [fav1, fav2, fav3].forEach(roomId => {
                    client.getRoom(roomId).tags = {
                        "m.favourite": {
                            order: 0.5,
                        },
                    };
                });

                [invite1, invite2].forEach(roomId => {
                    client.getRoom(roomId).getMyMembership.mockReturnValue("invite");
                });

                getUserIdForRoomId.mockImplementation(roomId => {
                    return {
                        [dm1]: dm1Partner.userId,
                        [dm2]: dm2Partner.userId,
                        [dm3]: dm3Partner.userId,
                    }[roomId];
                });
                getDMRoomsForUserId.mockImplementation(userId => {
                    switch (userId) {
                        case dm1Partner.userId:
                            return [dm1];
                        case dm2Partner.userId:
                            return [dm2];
                        case dm3Partner.userId:
                            return [dm3];
                        default:
                            return [];
                    }
                });

                // have dmPartner1 be in space1 with you
                const mySpace1Member = new RoomMember(space1, testUserId);
                mySpace1Member.membership = "join";
                (rooms.find(r => r.roomId === space1).getMembers as jest.Mock).mockReturnValue([
                    mySpace1Member,
                    dm1Partner,
                ]);
                // have dmPartner2 be in space2 with you
                const mySpace2Member = new RoomMember(space2, testUserId);
                mySpace2Member.membership = "join";
                (rooms.find(r => r.roomId === space2).getMembers as jest.Mock).mockReturnValue([
                    mySpace2Member,
                    dm2Partner,
                ]);
                // dmPartner3 is not in any common spaces with you

                await run();
            });

            it("home space contains orphaned rooms", () => {
                expect(store.getSpaceFilteredRoomIds(null).has(orphan1)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(null).has(orphan2)).toBeTruthy();
            });

            it("home space contains favourites", () => {
                expect(store.getSpaceFilteredRoomIds(null).has(fav1)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(null).has(fav2)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(null).has(fav3)).toBeTruthy();
            });

            it("home space contains dm rooms", () => {
                expect(store.getSpaceFilteredRoomIds(null).has(dm1)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(null).has(dm2)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(null).has(dm3)).toBeTruthy();
            });

            it("home space contains invites", () => {
                expect(store.getSpaceFilteredRoomIds(null).has(invite1)).toBeTruthy();
            });

            it("home space contains invites even if they are also shown in a space", () => {
                expect(store.getSpaceFilteredRoomIds(null).has(invite2)).toBeTruthy();
            });

            it("all rooms space does contain rooms/low priority even if they are also shown in a space", async () => {
                await setShowAllRooms(true);
                expect(store.getSpaceFilteredRoomIds(null).has(room1)).toBeTruthy();
            });

            it("home space doesn't contain rooms/low priority if they are also shown in a space", async () => {
                await setShowAllRooms(false);
                expect(store.getSpaceFilteredRoomIds(null).has(room1)).toBeFalsy();
            });

            it("space contains child rooms", () => {
                const space = client.getRoom(space1);
                expect(store.getSpaceFilteredRoomIds(space).has(fav1)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(space).has(room1)).toBeTruthy();
            });

            it("space contains child favourites", () => {
                const space = client.getRoom(space2);
                expect(store.getSpaceFilteredRoomIds(space).has(fav1)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(space).has(fav2)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(space).has(fav3)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(space).has(room1)).toBeTruthy();
            });

            it("space contains child invites", () => {
                const space = client.getRoom(space3);
                expect(store.getSpaceFilteredRoomIds(space).has(invite2)).toBeTruthy();
            });

            it("spaces contain dms which you have with members of that space", () => {
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space1)).has(dm1)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space2)).has(dm1)).toBeFalsy();
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space3)).has(dm1)).toBeFalsy();
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space1)).has(dm2)).toBeFalsy();
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space2)).has(dm2)).toBeTruthy();
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space3)).has(dm2)).toBeFalsy();
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space1)).has(dm3)).toBeFalsy();
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space2)).has(dm3)).toBeFalsy();
                expect(store.getSpaceFilteredRoomIds(client.getRoom(space3)).has(dm3)).toBeFalsy();
            });

            it("dms are only added to Notification States for only the Home Space", () => {
                // XXX: All rooms space is forcibly enabled, as part of a future PR test Home space better
                // [dm1, dm2, dm3].forEach(d => {
                //     expect(store.getNotificationState(HOME_SPACE).rooms.map(r => r.roomId).includes(d)).toBeTruthy();
                // });
                [space1, space2, space3].forEach(s => {
                    [dm1, dm2, dm3].forEach(d => {
                        expect(store.getNotificationState(s).rooms.map(r => r.roomId).includes(d)).toBeFalsy();
                    });
                });
            });

            it("orphan rooms are added to Notification States for only the Home Space", () => {
                // XXX: All rooms space is forcibly enabled, as part of a future PR test Home space better
                // [orphan1, orphan2].forEach(d => {
                //     expect(store.getNotificationState(HOME_SPACE).rooms.map(r => r.roomId).includes(d)).toBeTruthy();
                // });
                [space1, space2, space3].forEach(s => {
                    [orphan1, orphan2].forEach(d => {
                        expect(store.getNotificationState(s).rooms.map(r => r.roomId).includes(d)).toBeFalsy();
                    });
                });
            });

            it("favourites are added to Notification States for all spaces containing the room inc Home", () => {
                // XXX: All rooms space is forcibly enabled, as part of a future PR test Home space better
                // [fav1, fav2, fav3].forEach(d => {
                //     expect(store.getNotificationState(HOME_SPACE).rooms.map(r => r.roomId).includes(d)).toBeTruthy();
                // });
                expect(store.getNotificationState(space1).rooms.map(r => r.roomId).includes(fav1)).toBeTruthy();
                expect(store.getNotificationState(space1).rooms.map(r => r.roomId).includes(fav2)).toBeFalsy();
                expect(store.getNotificationState(space1).rooms.map(r => r.roomId).includes(fav3)).toBeFalsy();
                expect(store.getNotificationState(space2).rooms.map(r => r.roomId).includes(fav1)).toBeTruthy();
                expect(store.getNotificationState(space2).rooms.map(r => r.roomId).includes(fav2)).toBeTruthy();
                expect(store.getNotificationState(space2).rooms.map(r => r.roomId).includes(fav3)).toBeTruthy();
                expect(store.getNotificationState(space3).rooms.map(r => r.roomId).includes(fav1)).toBeFalsy();
                expect(store.getNotificationState(space3).rooms.map(r => r.roomId).includes(fav2)).toBeFalsy();
                expect(store.getNotificationState(space3).rooms.map(r => r.roomId).includes(fav3)).toBeFalsy();
            });

            it("other rooms are added to Notification States for all spaces containing the room exc Home", () => {
                // XXX: All rooms space is forcibly enabled, as part of a future PR test Home space better
                // expect(store.getNotificationState(HOME_SPACE).rooms.map(r => r.roomId).includes(room1)).toBeFalsy();
                expect(store.getNotificationState(space1).rooms.map(r => r.roomId).includes(room1)).toBeTruthy();
                expect(store.getNotificationState(space2).rooms.map(r => r.roomId).includes(room1)).toBeTruthy();
                expect(store.getNotificationState(space3).rooms.map(r => r.roomId).includes(room1)).toBeFalsy();
            });
        });
    });

    describe("hierarchy resolution update tests", () => {
        let emitter: EventEmitter;
        beforeEach(async () => {
            emitter = new EventEmitter();
            client.on.mockImplementation(emitter.on.bind(emitter));
            client.removeListener.mockImplementation(emitter.removeListener.bind(emitter));
        });
        afterEach(() => {
            client.on.mockReset();
            client.removeListener.mockReset();
        });

        it("updates state when spaces are joined", async () => {
            await run();
            expect(store.spacePanelSpaces).toStrictEqual([]);
            const space = mkSpace(space1);
            const prom = testUtils.emitPromise(store, UPDATE_TOP_LEVEL_SPACES);
            emitter.emit("Room", space);
            await prom;
            expect(store.spacePanelSpaces).toStrictEqual([space]);
            expect(store.invitedSpaces).toStrictEqual([]);
        });

        it("updates state when spaces are left", async () => {
            const space = mkSpace(space1);
            await run();

            expect(store.spacePanelSpaces).toStrictEqual([space]);
            space.getMyMembership.mockReturnValue("leave");
            const prom = testUtils.emitPromise(store, UPDATE_TOP_LEVEL_SPACES);
            emitter.emit("Room.myMembership", space, "leave", "join");
            await prom;
            expect(store.spacePanelSpaces).toStrictEqual([]);
        });

        it("updates state when space invite comes in", async () => {
            await run();
            expect(store.spacePanelSpaces).toStrictEqual([]);
            expect(store.invitedSpaces).toStrictEqual([]);
            const space = mkSpace(space1);
            space.getMyMembership.mockReturnValue("invite");
            const prom = testUtils.emitPromise(store, UPDATE_INVITED_SPACES);
            emitter.emit("Room", space);
            await prom;
            expect(store.spacePanelSpaces).toStrictEqual([]);
            expect(store.invitedSpaces).toStrictEqual([space]);
        });

        it("updates state when space invite is accepted", async () => {
            const space = mkSpace(space1);
            space.getMyMembership.mockReturnValue("invite");
            await run();

            expect(store.spacePanelSpaces).toStrictEqual([]);
            expect(store.invitedSpaces).toStrictEqual([space]);
            space.getMyMembership.mockReturnValue("join");
            const prom = testUtils.emitPromise(store, UPDATE_TOP_LEVEL_SPACES);
            emitter.emit("Room.myMembership", space, "join", "invite");
            await prom;
            expect(store.spacePanelSpaces).toStrictEqual([space]);
            expect(store.invitedSpaces).toStrictEqual([]);
        });

        it("updates state when space invite is rejected", async () => {
            const space = mkSpace(space1);
            space.getMyMembership.mockReturnValue("invite");
            await run();

            expect(store.spacePanelSpaces).toStrictEqual([]);
            expect(store.invitedSpaces).toStrictEqual([space]);
            space.getMyMembership.mockReturnValue("leave");
            const prom = testUtils.emitPromise(store, UPDATE_INVITED_SPACES);
            emitter.emit("Room.myMembership", space, "leave", "invite");
            await prom;
            expect(store.spacePanelSpaces).toStrictEqual([]);
            expect(store.invitedSpaces).toStrictEqual([]);
        });

        it("room invite gets added to relevant space filters", async () => {
            const space = mkSpace(space1, [invite1]);
            await run();

            expect(store.spacePanelSpaces).toStrictEqual([space]);
            expect(store.invitedSpaces).toStrictEqual([]);
            expect(store.getChildSpaces(space1)).toStrictEqual([]);
            expect(store.getChildRooms(space1)).toStrictEqual([]);
            expect(store.getSpaceFilteredRoomIds(client.getRoom(space1)).has(invite1)).toBeFalsy();
            expect(store.getSpaceFilteredRoomIds(null).has(invite1)).toBeFalsy();

            const invite = mkRoom(invite1);
            invite.getMyMembership.mockReturnValue("invite");
            const prom = testUtils.emitPromise(store, space1);
            emitter.emit("Room", space);
            await prom;

            expect(store.spacePanelSpaces).toStrictEqual([space]);
            expect(store.invitedSpaces).toStrictEqual([]);
            expect(store.getChildSpaces(space1)).toStrictEqual([]);
            expect(store.getChildRooms(space1)).toStrictEqual([invite]);
            expect(store.getSpaceFilteredRoomIds(client.getRoom(space1)).has(invite1)).toBeTruthy();
            expect(store.getSpaceFilteredRoomIds(null).has(invite1)).toBeTruthy();
        });
    });

    describe("active space switching tests", () => {
        const fn = jest.spyOn(store, "emit");

        beforeEach(async () => {
            mkRoom(room1); // not a space
            mkSpace(space1, [
                mkSpace(space2).roomId,
            ]);
            mkSpace(space3).getMyMembership.mockReturnValue("invite");
            await run();
            await store.setActiveSpace(null);
            expect(store.activeSpace).toBe(null);
        });
        afterEach(() => {
            fn.mockClear();
        });

        it("switch to home space", async () => {
            await store.setActiveSpace(client.getRoom(space1));
            fn.mockClear();

            await store.setActiveSpace(null);
            expect(fn).toHaveBeenCalledWith(UPDATE_SELECTED_SPACE, null);
            expect(store.activeSpace).toBe(null);
        });

        it("switch to invited space", async () => {
            const space = client.getRoom(space3);
            await store.setActiveSpace(space);
            expect(fn).toHaveBeenCalledWith(UPDATE_SELECTED_SPACE, space);
            expect(store.activeSpace).toBe(space);
        });

        it("switch to top level space", async () => {
            const space = client.getRoom(space1);
            await store.setActiveSpace(space);
            expect(fn).toHaveBeenCalledWith(UPDATE_SELECTED_SPACE, space);
            expect(store.activeSpace).toBe(space);
        });

        it("switch to subspace", async () => {
            const space = client.getRoom(space2);
            await store.setActiveSpace(space);
            expect(fn).toHaveBeenCalledWith(UPDATE_SELECTED_SPACE, space);
            expect(store.activeSpace).toBe(space);
        });

        it("switch to unknown space is a nop", async () => {
            expect(store.activeSpace).toBe(null);
            const space = client.getRoom(room1); // not a space
            await store.setActiveSpace(space);
            expect(fn).not.toHaveBeenCalledWith(UPDATE_SELECTED_SPACE, space);
            expect(store.activeSpace).toBe(null);
        });
    });

    describe("context switching tests", () => {
        let dispatcherRef;
        let currentRoom = null;

        beforeEach(async () => {
            [room1, room2, orphan1].forEach(mkRoom);
            mkSpace(space1, [room1, room2]);
            mkSpace(space2, [room2]);
            await run();

            dispatcherRef = defaultDispatcher.register(payload => {
                if (payload.action === "view_room" || payload.action === "view_home_page") {
                    currentRoom = payload.room_id || null;
                }
            });
        });
        afterEach(() => {
            localStorage.clear();
            defaultDispatcher.unregister(dispatcherRef);
        });

        const getCurrentRoom = () => {
            jest.runAllTimers();
            return currentRoom;
        };

        it("last viewed room in target space is the current viewed and in both spaces", async () => {
            await store.setActiveSpace(client.getRoom(space1));
            viewRoom(room2);
            await store.setActiveSpace(client.getRoom(space2));
            viewRoom(room2);
            await store.setActiveSpace(client.getRoom(space1));
            expect(getCurrentRoom()).toBe(room2);
        });

        it("last viewed room in target space is in the current space", async () => {
            await store.setActiveSpace(client.getRoom(space1));
            viewRoom(room2);
            await store.setActiveSpace(client.getRoom(space2));
            expect(getCurrentRoom()).toBe(space2);
            await store.setActiveSpace(client.getRoom(space1));
            expect(getCurrentRoom()).toBe(room2);
        });

        it("last viewed room in target space is not in the current space", async () => {
            await store.setActiveSpace(client.getRoom(space1));
            viewRoom(room1);
            await store.setActiveSpace(client.getRoom(space2));
            viewRoom(room2);
            await store.setActiveSpace(client.getRoom(space1));
            expect(getCurrentRoom()).toBe(room1);
        });

        it("last viewed room is target space is not known", async () => {
            await store.setActiveSpace(client.getRoom(space1));
            viewRoom(room1);
            localStorage.setItem(`mx_space_context_${space2}`, orphan2);
            await store.setActiveSpace(client.getRoom(space2));
            expect(getCurrentRoom()).toBe(space2);
        });

        it("last viewed room is target space is no longer in that space", async () => {
            await store.setActiveSpace(client.getRoom(space1));
            viewRoom(room1);
            localStorage.setItem(`mx_space_context_${space2}`, room1);
            await store.setActiveSpace(client.getRoom(space2));
            expect(getCurrentRoom()).toBe(space2); // Space home instead of room1
        });

        it("no last viewed room in target space", async () => {
            await store.setActiveSpace(client.getRoom(space1));
            viewRoom(room1);
            await store.setActiveSpace(client.getRoom(space2));
            expect(getCurrentRoom()).toBe(space2);
        });

        it("no last viewed room in home space", async () => {
            await store.setActiveSpace(client.getRoom(space1));
            viewRoom(room1);
            await store.setActiveSpace(null);
            expect(getCurrentRoom()).toBeNull(); // Home
        });
    });

    describe("space auto switching tests", () => {
        beforeEach(async () => {
            [room1, room2, room3, orphan1].forEach(mkRoom);
            mkSpace(space1, [room1, room2, room3]);
            mkSpace(space2, [room1, room2]);

            const cliRoom2 = client.getRoom(room2);
            cliRoom2.currentState.getStateEvents.mockImplementation(testUtils.mockStateEventImplementation([
                mkEvent({
                    event: true,
                    type: EventType.SpaceParent,
                    room: room2,
                    user: testUserId,
                    skey: space2,
                    content: { via: [], canonical: true },
                    ts: Date.now(),
                }),
            ]));
            await run();
        });

        it("no switch required, room is in current space", async () => {
            viewRoom(room1);
            await store.setActiveSpace(client.getRoom(space1), false);
            viewRoom(room2);
            expect(store.activeSpace).toBe(client.getRoom(space1));
        });

        it("switch to canonical parent space for room", async () => {
            viewRoom(room1);
            await store.setActiveSpace(client.getRoom(space2), false);
            viewRoom(room2);
            expect(store.activeSpace).toBe(client.getRoom(space2));
        });

        it("switch to first containing space for room", async () => {
            viewRoom(room2);
            await store.setActiveSpace(client.getRoom(space2), false);
            viewRoom(room3);
            expect(store.activeSpace).toBe(client.getRoom(space1));
        });

        it("switch to home for orphaned room", async () => {
            viewRoom(room1);
            await store.setActiveSpace(client.getRoom(space1), false);
            viewRoom(orphan1);
            expect(store.activeSpace).toBeNull();
        });

        it("when switching rooms in the all rooms home space don't switch to related space", async () => {
            await setShowAllRooms(true);
            viewRoom(room2);
            await store.setActiveSpace(null, false);
            viewRoom(room1);
            expect(store.activeSpace).toBeNull();
        });
    });

    describe("traverseSpace", () => {
        beforeEach(() => {
            mkSpace("!a:server", [
                mkSpace("!b:server", [
                    mkSpace("!c:server", [
                        "!a:server",
                        mkRoom("!c-child:server").roomId,
                        mkRoom("!shared-child:server").roomId,
                    ]).roomId,
                    mkRoom("!b-child:server").roomId,
                ]).roomId,
                mkRoom("!a-child:server").roomId,
                "!shared-child:server",
            ]);
        });

        it("avoids cycles", () => {
            const fn = jest.fn();
            store.traverseSpace("!b:server", fn);

            expect(fn).toBeCalledTimes(3);
            expect(fn).toBeCalledWith("!a:server");
            expect(fn).toBeCalledWith("!b:server");
            expect(fn).toBeCalledWith("!c:server");
        });

        it("including rooms", () => {
            const fn = jest.fn();
            store.traverseSpace("!b:server", fn, true);

            expect(fn).toBeCalledTimes(8); // twice for shared-child
            expect(fn).toBeCalledWith("!a:server");
            expect(fn).toBeCalledWith("!a-child:server");
            expect(fn).toBeCalledWith("!b:server");
            expect(fn).toBeCalledWith("!b-child:server");
            expect(fn).toBeCalledWith("!c:server");
            expect(fn).toBeCalledWith("!c-child:server");
            expect(fn).toBeCalledWith("!shared-child:server");
        });

        it("excluding rooms", () => {
            const fn = jest.fn();
            store.traverseSpace("!b:server", fn, false);

            expect(fn).toBeCalledTimes(3);
            expect(fn).toBeCalledWith("!a:server");
            expect(fn).toBeCalledWith("!b:server");
            expect(fn).toBeCalledWith("!c:server");
        });
    });
});
