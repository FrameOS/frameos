all:
	nimble build -y


toormoos:
	nim c --os:linux --cpu:arm64 --compileOnly --genScript --nimcache:tmp/build_1 src/frameos.nim
	cp /opt/homebrew/Cellar/nim/2.0.0_1/nim/lib/nimbase.h tmp/build_1/nimbase.h
	awk 'NR==FNR{total=NR; next} {printf "echo Compiling on device: %d/%d\n", NR - total, total; print}' tmp/build_1/compile_frameos.sh tmp/build_1/compile_frameos.sh > tmp/build_1/compile_frameos.sh.awk && mv tmp/build_1/compile_frameos.sh.awk tmp/build_1/compile_frameos.sh
	(cd tmp && tar -czf ./build_1.tar.gz build_1)
	scp -r tmp/build_1.tar.gz toormoos:
	ssh toormoos "rm -rf build_1 && tar -xzf build_1.tar.gz && cd build_1 && sh ./compile_frameos.sh && ./frameos"
