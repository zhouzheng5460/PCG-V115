// 烘焙好的 Placemaker 停车布局（由 `npx tsx tools/bake-parking.ts` 生成）
//
// 注册动作已经挪进 `provider.ts`（模块加载即注册），这里只留一个元信息出口。
// 保留这个文件是为了让"烘焙产物"有一个明确的目录归属。
export { BAKED_META as BAKED_PARKING_META } from '../provider';
