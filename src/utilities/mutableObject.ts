import * as I from '../interfaces/index';

export type ObjectPath = Array<string | number>;

export class MutableObject {
    data: any = {};

    assignAndPropagate(obj: any, index: number, path: ObjectPath, value: any) {
        if (index === path.length - 1) {
            // when deleting array element we need to shift all other elements manually
            if (value === undefined && typeof path[index] === 'number') {
                let deleted: number = <number>path[index];
                for (let i = deleted; i < obj.length - 1; i++) {
                    obj[i] = obj[i + 1];
                }
                obj.pop();
            } else {
                obj[path[index]] = value;
            }
            return;
        }

        if (!obj[path[index]]) {
            // nested element is either array or object
            if (typeof path[index + 1] === 'number') {
                obj[path[index]] = [];
            } else {
                obj[path[index]] = {};
            }
        }

        this.assignAndPropagate(obj[path[index]], index + 1, path, value);
    }

    // e.g. setAtPath(['create', 'resale_shares', 3, 'receiver'], 'ultra')
    setAtPath(path: ObjectPath, value: any) {
        this.assignAndPropagate(this.data, 0, path, value);
    }

    getAtPath(path: ObjectPath) {
        let tmp = this.data;
        for (let p of path) {
            if (!tmp) return undefined;
            tmp = tmp[p];
        }
        return tmp;
    }
}
