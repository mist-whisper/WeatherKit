### 🆕 New Features
  * none

### 🛠️ Bug Fixes
  * none

### 🔣 Dependencies
  * none

### ‼️ Breaking Changes
  * none

### 🔄 Other Changes
  * 从功能描述中移除“修改下一小时降水数据”：WK3（iOS 18+）下，Apple 未提供 NextHour 的地区无法通过补槽 5 实现未来一小时降水。真机验证 7 次全部被拒（3 种根表构造 × 2 种降水内容 × 3 个国家），App 会拒收任何含新增 slot 5 的包体。移除该描述以免误导用户；空气质量、天气、预警等功能不受影响。
  * NextHour.Provider 设置保留（WK2 下仍可用；WK3 下在 Apple 已提供 NextHour 的地区无需补槽，在未提供的地区补槽会被 App 拒收）。
